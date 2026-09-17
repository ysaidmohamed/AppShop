import 'dotenv/config'
import crypto from 'node:crypto'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Stripe from 'stripe'

// Chargement des dépendances nécessaires pour l’API Express, le stockage local, la session et le paiement Stripe.
const mysql = await import('mysql2/promise').catch(() => null)

// Instanciation du serveur HTTP et de ses paramètres de configuration.
const app = express()
const port = process.env.PORT || 4242
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null
const rootDir = path.dirname(fileURLToPath(import.meta.url))
const databasePath = path.join(rootDir, 'db.json')
const ordersPath = path.join(rootDir, 'orders.json')
const usersPath = path.join(rootDir, 'users-data.json')
const sessionSecret = process.env.SESSION_SECRET || 'appshop-local-secret'
const sessionStore = new Map()

// Si des variables de configuration MySQL sont présentes, on utilise une base de données réelle.
// Sinon, on retombe sur des fichiers JSON pour simuler le stockage.
const dbConfig = process.env.DB_HOST && process.env.DB_NAME
  ? {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    }
  : null

const mysqlPool = dbConfig && mysql ? mysql.createPool(dbConfig) : null

// Middleware pour lire les requêtes JSON envoyées par le front Vue.
app.use(express.json())

// Lit un fichier JSON ou renvoie une valeur de secours si le fichier est absent ou invalide.
function readJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function readOrders() {
  return readJsonFile(ordersPath, [])
}

function writeOrders(orders) {
  writeJsonFile(ordersPath, orders)
}

function readUsers() {
  return readJsonFile(usersPath, [])
}

function writeUsers(users) {
  writeJsonFile(usersPath, users)
}

// Renvoie la liste des utilisateurs depuis MySQL si disponible, sinon depuis le fichier JSON local.
async function getUsersFromStore() {
  if (mysqlPool) {
    try {
      const [rows] = await mysqlPool.query('SELECT * FROM users')
      return rows
    } catch {
      return readUsers()
    }
  }

  return readUsers()
}

// Enregistre un nouvel utilisateur dans la source active (MySQL ou JSON local).
async function saveUserToStore(user) {
  if (mysqlPool) {
    try {
      await mysqlPool.query(
        'INSERT INTO users (first_name, last_name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        [user.first_name, user.last_name, user.email, user.password_hash, user.role, user.is_active ? 1 : 0],
      )
      return true
    } catch {
      const users = readUsers()
      users.push(user)
      writeUsers(users)
      return true
    }
  }

  const users = readUsers()
  users.push(user)
  writeUsers(users)
  return true
}

function normalizeOrderShape(order, itemRows = []) {
  return {
    id: String(order.stripe_session_id || order.id),
    amountTotal: Number(order.amount_total ?? order.amountTotal ?? 0),
    currency: order.currency || 'eur',
    created: Number(order.created_at ? new Date(order.created_at).getTime() / 1000 : (order.created ?? Math.floor(Date.now() / 1000))),
    paymentStatus: order.status || order.paymentStatus || 'paid',
    items: (itemRows.length ? itemRows : (order.items ?? [])).map((item) => ({
      name: item.product_name ?? item.name ?? null,
      quantity: Number(item.quantity ?? item.qty ?? item.quantity ?? 1),
      amountTotal: Number(item.total_amount ?? item.amountTotal ?? 0),
    })),
    userId: order.user_id ?? order.userId ?? null,
  }
}

async function getOrdersFromStore() {
  if (mysqlPool) {
    try {
      const [orders] = await mysqlPool.query(
        'SELECT * FROM orders ORDER BY created_at DESC',
      )

      if (!orders.length) {
        return []
      }

      const orderIds = orders.map((order) => order.id)
      const [items] = await mysqlPool.query(
        'SELECT * FROM order_items WHERE order_id IN (?) ORDER BY created_at DESC',
        [orderIds],
      )

      return orders.map((order) => {
        const itemRows = items.filter((item) => Number(item.order_id) === Number(order.id))
        return normalizeOrderShape(order, itemRows)
      })
    } catch (error) {
      console.error('MySQL orders read failed:', error)
      return readOrders()
    }
  }

  return readOrders()
}

async function saveOrderToStore(order) {
  if (mysqlPool) {
    try {
      const paidAt = (Number(order.created) || Math.floor(Date.now() / 1000)) * 1000
      const [result] = await mysqlPool.query(
        'INSERT INTO orders (user_id, stripe_session_id, status, amount_total, currency, paid_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          order.userId ?? null,
          order.id,
          order.paymentStatus || 'paid',
          Number(order.amountTotal) || 0,
          order.currency || 'eur',
          new Date(paidAt).toISOString().slice(0, 19).replace('T', ' '),
        ],
      )

      const orderId = result.insertId

      for (const item of order.items ?? []) {
        await mysqlPool.query(
          'INSERT INTO order_items (order_id, product_name, quantity, unit_amount, total_amount) VALUES (?, ?, ?, ?, ?)',
          [
            orderId,
            item.name || 'Produit',
            Number(item.quantity) || 1,
            Number(item.amountTotal) || 0,
            Number(item.amountTotal) || 0,
          ],
        )
      }

      const [rows] = await mysqlPool.query(
        'SELECT * FROM orders WHERE stripe_session_id = ? LIMIT 1',
        [String(order.id)],
      )

      return rows[0] || null
    } catch (error) {
      console.error('MySQL order save failed:', error)
      throw error
    }
  }

  const orders = readOrders()
  orders.unshift({ ...order, userId: order.userId ?? null })
  writeOrders(orders)
  return true
}

async function getUserOrders(userId) {
  const orders = await getOrdersFromStore()
  return orders.filter((order) => String(order.userId ?? '') === String(userId))
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, storedHash) {
  if (!storedHash) {
    return false
  }

  const [salt, hash] = storedHash.split(':')

  if (!salt || !hash) {
    return false
  }

  const computed = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
  return computed === hash
}

// Génère un jeton de session unique pour l’utilisateur connecté.
function createSessionToken(userId) {
  const token = crypto
    .createHmac('sha256', sessionSecret)
    .update(`${userId}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`)
    .digest('hex')

  sessionStore.set(token, userId)
  return token
}

// Extrait le jeton depuis l’en-tête Authorization ou le header personnalisé.
function getTokenFromRequest(request) {
  const bearer = request.headers.authorization

  if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) {
    return bearer.slice(7)
  }

  const fallback = request.headers['x-session-token']
  return typeof fallback === 'string' ? fallback : null
}

async function getCurrentUserFromRequest(request) {
  const token = getTokenFromRequest(request)

  if (!token) {
    return null
  }

  const userId = sessionStore.get(token)

  if (!userId) {
    return null
  }

  const users = await getUsersFromStore()
  const user = users.find((entry) => entry.id === userId)

  if (!user) {
    sessionStore.delete(token)
    return null
  }

  const { password_hash: _passwordHash, ...safeUser } = user
  return safeUser
}

async function requireAuth(request, response, next) {
  const user = await getCurrentUserFromRequest(request)

  if (!user) {
    return response.status(401).json({ error: 'Non authentifié.' })
  }

  request.user = user
  return next()
}

function sanitizeUser(user) {
  const { password_hash: _passwordHash, ...safeUser } = user
  return safeUser
}

// Point de contrôle rapide pour vérifier que l’API est bien en ligne.
app.get('/api/health', (_request, response) => {
  response.json({ ok: true, timestamp: new Date().toISOString() })
})

// Route d’inscription : validation du formulaire puis création du compte et du token de session.
app.post('/api/register', async (request, response) => {
  const { firstName, lastName, email, password } = request.body ?? {}
  const normalizedEmail = String(email ?? '').trim().toLowerCase()
  const sanitizedFirstName = String(firstName ?? '').trim()
  const sanitizedLastName = String(lastName ?? '').trim()

  if (!sanitizedFirstName || !sanitizedLastName || !normalizedEmail || !String(password ?? '').trim()) {
    return response.status(400).json({ error: 'Tous les champs sont requis.' })
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return response.status(400).json({ error: 'Adresse e-mail invalide.' })
  }

  if (String(password).length < 6) {
    return response.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' })
  }

  const users = await getUsersFromStore()

  if (users.some((user) => user.email === normalizedEmail)) {
    return response.status(409).json({ error: 'Un compte existe déjà pour cette adresse e-mail.' })
  }

  const nextId = users.length ? Math.max(...users.map((user) => Number(user.id) || 0)) + 1 : 1
  const user = {
    id: nextId,
    first_name: sanitizedFirstName,
    last_name: sanitizedLastName,
    email: normalizedEmail,
    password_hash: hashPassword(String(password)),
    role: 'customer',
    is_active: true,
    created_at: new Date().toISOString(),
  }

  await saveUserToStore(user)

  const token = createSessionToken(user.id)
  return response.status(201).json({
    token,
    user: sanitizeUser(user),
  })
})

app.post('/api/login', async (request, response) => {
  const { email, password } = request.body ?? {}
  const normalizedEmail = String(email ?? '').trim().toLowerCase()

  if (!normalizedEmail || !String(password ?? '').trim()) {
    return response.status(400).json({ error: 'Email et mot de passe requis.' })
  }

  const users = await getUsersFromStore()
  const user = users.find((entry) => entry.email === normalizedEmail)

  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return response.status(401).json({ error: 'Identifiants invalides.' })
  }

  const token = createSessionToken(user.id)
  return response.json({
    token,
    user: sanitizeUser(user),
  })
})

app.get('/api/me', requireAuth, (request, response) => {
  response.json({ user: request.user })
})

app.post('/api/logout', (request, response) => {
  const token = getTokenFromRequest(request)

  if (token) {
    sessionStore.delete(token)
  }

  return response.json({ ok: true })
})

app.get('/api/orders', requireAuth, async (request, response) => {
  const orders = await getUserOrders(request.user.id)
  return response.json(orders)
})

app.post('/api/orders', requireAuth, async (request, response) => {
  const { id, amountTotal, currency, created, paymentStatus, items } = request.body ?? {}

  if (!id || !Array.isArray(items)) {
    return response.status(400).json({ error: 'Commande invalide.' })
  }

  const order = {
    id,
    userId: request.user.id,
    amountTotal: Number(amountTotal) || 0,
    currency: currency || 'eur',
    created: Number(created) || Math.floor(Date.now() / 1000),
    paymentStatus: paymentStatus || 'paid',
    items: items.map((item) => ({
      name: item?.name ?? null,
      quantity: Number(item?.quantity ?? 1),
      amountTotal: Number(item?.amountTotal) || 0,
    })),
  }

  const orders = await getOrdersFromStore()
  const existingOrder = orders.find((entry) => String(entry.id) === String(order.id))

  if (existingOrder) {
    return response.json(existingOrder)
  }

  try {
    const savedOrder = await saveOrderToStore(order)

    if (!savedOrder) {
      return response.status(500).json({ error: 'La commande n’a pas été enregistrée en base de données.' })
    }

    const savedOrders = await getUserOrders(request.user.id)
    const persistedOrder = savedOrders.find((entry) => String(entry.id) === String(order.id)) ?? savedOrder

    return response.status(201).json(persistedOrder)
  } catch (error) {
    console.error('POST /api/orders failed:', error)
    return response.status(500).json({ error: 'La commande n’a pas pu être enregistrée.' })
  }
})

// Crée une session Stripe à partir du panier du client et redirige vers le paiement.
app.post('/api/create-checkout-session', requireAuth, async (request, response) => {
  if (!stripe) {
    return response.status(500).json({ error: 'STRIPE_SECRET_KEY est manquante dans le fichier .env.' })
  }

  try {
    const { items } = request.body
    const products = JSON.parse(fs.readFileSync(databasePath, 'utf8')).products

    if (!Array.isArray(items) || !items.length) {
      return response.status(400).json({ error: 'Le panier est vide.' })
    }

    const lineItems = items.map((item) => {
      const product = products.find((entry) => entry.id === item.productId)
      const quantity = Number(item.quantity)

      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        throw new Error('Le panier contient un article invalide.')
      }

      return {
        price_data: {
          currency: 'eur',
          product_data: { name: product.name },
          unit_amount: Math.round(product.price * 100),
        },
        quantity,
      }
    })

    const origin = request.headers.origin || 'http://localhost:5173'
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
    })

    return response.json({ url: session.url })
  } catch (error) {
    console.error(error)
    return response.status(400).json({ error: error.message || 'Impossible de créer la session de paiement.' })
  }
})

app.get('/api/checkout-session/:sessionId', requireAuth, async (request, response) => {
  if (!stripe) {
    return response.status(500).json({ error: 'STRIPE_SECRET_KEY est manquante dans le fichier .env.' })
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(request.params.sessionId, {
      expand: ['line_items'],
    })

    const order = {
      id: session.id,
      userId: request.user.id,
      amountTotal: session.amount_total,
      currency: session.currency,
      created: session.created,
      paymentStatus: session.payment_status,
      items: session.line_items.data.map((item) => ({
        name: item.description,
        quantity: item.quantity,
        amountTotal: item.amount_total,
      })),
    }

    const orders = await getOrdersFromStore()
    const alreadySaved = orders.some((entry) => String(entry.id) === String(order.id))

    if (!alreadySaved) {
      try {
        const savedOrder = await saveOrderToStore(order)

        if (!savedOrder) {
          throw new Error('Order not saved to MySQL after checkout session retrieval.')
        }
      } catch (error) {
        console.error('Persistent checkout order save failed:', error)
        return response.status(500).json({ error: 'La commande Stripe n’a pas pu être enregistrée.' })
      }
    }

    const persistedOrders = await getUserOrders(request.user.id)
    const persistedOrder = persistedOrders.find((entry) => String(entry.id) === String(order.id)) ?? order

    return response.json(persistedOrder)
  } catch (error) {
    console.error(error)
    return response.status(404).json({ error: 'Commande Stripe introuvable.' })
  }
})

app.listen(port, () => {
  console.log(`Stripe server running on http://localhost:${port}`)
  console.log('mysqlPool active:', Boolean(mysqlPool))
})
