<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import catalog from '../db.json'

// Données du catalogue affichées dans la boutique.
const products = catalog.products

type Product = (typeof products)[number]
type CartItem = { product: Product; quantity: number }
type OrderItem = { name: string | null; quantity: number | null; amountTotal: number }
type Order = {
  id: string
  amountTotal: number
  currency: string
  created: number
  paymentStatus: string
  items: OrderItem[]
}

// État global de l’application : panier, commandes, authentification et modales.
const cartItems = ref<CartItem[]>([])
const orderHistory = ref<Order[]>([])
const selectedOrderId = ref<string | null>(null)
const cartOpen = ref(false)
const ordersOpen = ref(false)
const authOpen = ref(false)
const authMode = ref<'login' | 'register'>('login')
const authToken = ref(localStorage.getItem('appshop-token') ?? '')
const currentUser = ref<{ id: number; first_name: string; last_name: string; email: string; role: string } | null>(null)
const authForm = ref({
  firstName: '',
  lastName: '',
  email: '',
  password: '',
})
const authError = ref('')
const orderConfirmation = ref<number | null>(null)
const checkoutError = ref('')
// Calculs dérivés du panier et du total de la commande sélectionnée.
const cartCount = computed(() =>
  cartItems.value.reduce((count, item) => count + item.quantity, 0),
)
const cartTotal = computed(() =>
  cartItems.value.reduce((total, item) => total + item.product.price * item.quantity, 0),
)
const selectedOrder = computed(() =>
  orderHistory.value.find((order) => order.id === selectedOrderId.value) ?? null,
)

// Ouvre ou ferme le détail d’une commande dans l’historique.
function openOrder(orderId: string) {
  selectedOrderId.value = selectedOrderId.value === orderId ? null : orderId
}

// Récupère l’utilisateur courant à partir du jeton enregistré en localStorage.
async function loadCurrentUser() {
  if (!authToken.value) {
    currentUser.value = null
    return
  }

  try {
    const response = await fetch('/api/me', {
      headers: { Authorization: `Bearer ${authToken.value}` },
    })

    if (!response.ok) {
      throw new Error('Session invalide')
    }

    const payload = await response.json()
    currentUser.value = payload.user
    await loadOrderHistory()
  } catch {
    authToken.value = ''
    currentUser.value = null
    localStorage.removeItem('appshop-token')
  }
}

// Charge l’historique des commandes depuis l’API ou depuis le stockage local si l’utilisateur n’est pas connecté.
async function loadOrderHistory() {
  if (!currentUser.value || !authToken.value) {
    const savedOrders = localStorage.getItem('appshop-orders')
    orderHistory.value = savedOrders ? JSON.parse(savedOrders) : []
    return
  }

  try {
    const response = await fetch('/api/orders', {
      headers: { Authorization: `Bearer ${authToken.value}` },
    })

    if (!response.ok) {
      throw new Error('Impossible de récupérer les commandes.')
    }

    const orders = (await response.json()) as Order[]
    orderHistory.value = orders
    localStorage.setItem('appshop-orders', JSON.stringify(orders))
  } catch {
    orderHistory.value = []
  }
}

// Au montage du composant, on restaure l’historique et on vérifie si la page revient d’un paiement Stripe.
onMounted(async () => {
  const savedOrders = localStorage.getItem('appshop-orders')
  orderHistory.value = savedOrders ? JSON.parse(savedOrders) : []
  selectedOrderId.value = null
  await loadCurrentUser()

  const sessionId = new URLSearchParams(window.location.search).get('session_id')

  if (!sessionId || (orderHistory.value.some((order) => order.id === sessionId) && !currentUser.value)) {
    return
  }

  if (!sessionId) {
    return
  }

  try {
    const response = await fetch(`/api/checkout-session/${sessionId}`, {
      headers: currentUser.value && authToken.value
        ? { Authorization: `Bearer ${authToken.value}` }
        : undefined,
    })

    if (!response.ok) {
      return
    }

    const order = (await response.json()) as Order

    if (currentUser.value && authToken.value) {
      await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken.value}`,
        },
        body: JSON.stringify(order),
      }).catch(() => undefined)
    }

    orderHistory.value = [order, ...orderHistory.value.filter((entry) => entry.id !== order.id)]
    orderConfirmation.value = order.amountTotal / 100
    localStorage.setItem('appshop-orders', JSON.stringify(orderHistory.value))
    window.history.replaceState({}, '', window.location.pathname)
  } catch {
    return
  }
})

// Ajoute un produit au panier en incrémentant la quantité si le produit est déjà présent.
function addToCart(product: Product) {
  const cartItem = cartItems.value.find((item) => item.product.id === product.id)

  if (cartItem) {
    cartItem.quantity += 1
    return
  }

  cartItems.value.push({ product, quantity: 1 })
}

function updateQuantity(index: number, change: number) {
  const cartItem = cartItems.value[index]

  if (!cartItem) {
    return
  }

  cartItem.quantity += change

  if (cartItem.quantity <= 0) {
    cartItems.value.splice(index, 1)
  }
}

function removeProduct(index: number) {
  cartItems.value.splice(index, 1)
}

// Initialise le paiement Stripe uniquement si l’utilisateur est connecté et que le panier n’est pas vide.
async function checkout() {
  if (!cartItems.value.length) {
    return
  }

  if (!currentUser.value || !authToken.value) {
    authOpen.value = true
    authMode.value = 'login'
    authError.value = 'Connectez-vous pour passer une commande.'
    cartOpen.value = false
    return
  }

  checkoutError.value = ''

  try {
    const response = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken.value}`,
      },
      body: JSON.stringify({
        items: cartItems.value.map((item) => ({
          productId: item.product.id,
          quantity: item.quantity,
        })),
      }),
    })
    const result = await response.json()

    if (!response.ok || !result.url) {
      throw new Error(result.error || 'Impossible de lancer le paiement.')
    }

    window.location.href = result.url
  } catch (error) {
    checkoutError.value = error instanceof Error ? error.message : 'Une erreur est survenue.'
  }
}

// Envoie le formulaire de connexion ou d’inscription vers l’API et stocke le token de session.
async function submitAuth() {
  authError.value = ''

  try {
    const endpoint = authMode.value === 'login' ? '/api/login' : '/api/register'
    const payload = authMode.value === 'login'
      ? {
          email: authForm.value.email,
          password: authForm.value.password,
        }
      : {
          firstName: authForm.value.firstName,
          lastName: authForm.value.lastName,
          email: authForm.value.email,
          password: authForm.value.password,
        }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const result = await response.json()

    if (!response.ok) {
      throw new Error(result.error || 'Impossible de continuer.')
    }

    authToken.value = result.token
    currentUser.value = result.user
    localStorage.setItem('appshop-token', result.token)
    await loadOrderHistory()
    authOpen.value = false
    authForm.value = { firstName: '', lastName: '', email: '', password: '' }
  } catch (error) {
    authError.value = error instanceof Error ? error.message : 'Une erreur est survenue.'
  }
}

// Déconnecte l’utilisateur et nettoie l’état local et la session distante.
async function logout() {
  if (authToken.value) {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken.value}` },
    }).catch(() => undefined)
  }

  authToken.value = ''
  currentUser.value = null
  selectedOrderId.value = null
  orderHistory.value = []
  localStorage.removeItem('appshop-token')
  authOpen.value = false
}
</script>

<template>
  <header class="site-header">
    <div class="header-top">
      <a class="brand" href="/">AppShop</a>

      <div class="header-actions">
        <button
          class="account-button"
          type="button"
          @click="authOpen = !authOpen; cartOpen = false; ordersOpen = false"
        >
          {{ currentUser ? `${currentUser.first_name} ${currentUser.last_name}` : 'Connexion' }}
        </button>

        <button
          class="cart-button"
          type="button"
          aria-label="Ouvrir ou fermer le panier"
          :aria-expanded="cartOpen"
          @click="cartOpen = !cartOpen; ordersOpen = false; authOpen = false"
        >
          Panier <span>{{ cartCount }}</span>
        </button>
      </div>
    </div>

    <nav class="main-navigation" aria-label="Navigation principale">
      <a href="#accueil">Accueil</a>
      <a href="#produits">Produits</a>
      <a href="#commandes" @click.prevent="ordersOpen = true; cartOpen = false; authOpen = false; loadOrderHistory()">Commandes</a>
      <a href="#contact">Contact</a>
    </nav>
  </header>

  <main id="accueil">
    <p v-if="orderConfirmation !== null" class="order-confirmation" role="status">
      Commande confirmée pour un total de
      {{ orderConfirmation.toFixed(2).replace('.', ',') }} €.
    </p>

    <section class="hero" aria-labelledby="hero-title">
      <p class="eyebrow">La boutique des passionnés du web</p>
      <h1 id="hero-title">Coder avec style.</h1>
      <p class="hero-text">
        Découvre une sélection d’accessoires et de vêtements pensés pour les développeurs.
      </p>
      <a class="primary-button" href="#produits">Découvrir les produits</a>
    </section>

    <section id="produits" class="products-section" aria-labelledby="products-title">
      <p class="eyebrow">La collection</p>
      <h2 id="products-title">Nos produits</h2>

      <div class="products-grid">
        <article v-for="product in products" :key="product.id" class="product-card">
          <div class="product-image-wrapper">
            <img :src="product.image" :alt="product.name" class="product-image" />
          </div>
          <div class="product-info">
            <h3>{{ product.name }}</h3>
            <p>{{ product.description }}</p>
            <strong>{{ product.price.toFixed(2).replace('.', ',') }} €</strong>
            <button class="add-button" type="button" @click="addToCart(product)">
              Ajouter au panier
            </button>
          </div>
        </article>
      </div>
    </section>

  </main>

  <div
    v-if="cartOpen || ordersOpen || authOpen"
    class="cart-overlay"
    aria-hidden="true"
    @click="cartOpen = false; ordersOpen = false; authOpen = false"
  ></div>

  <aside v-if="authOpen" class="auth-panel" aria-labelledby="auth-title">
    <div class="cart-heading">
      <div>
        <p class="eyebrow">Compte</p>
        <h2 id="auth-title">{{ currentUser ? 'Mon compte' : authMode === 'login' ? 'Connexion' : 'Créer un compte' }}</h2>
      </div>
      <button class="close-cart" type="button" aria-label="Fermer la fenêtre de compte" @click="authOpen = false">
        Fermer
      </button>
    </div>

    <div v-if="currentUser" class="auth-account">
      <p>Bonjour {{ currentUser.first_name }} {{ currentUser.last_name }}.</p>
      <p class="auth-email">{{ currentUser.email }}</p>
      <button class="checkout-button" type="button" @click="logout">Se déconnecter</button>
    </div>

    <form v-else class="auth-form" @submit.prevent="submitAuth">
      <div v-if="authMode === 'register'" class="auth-row">
        <label>
          Prénom
          <input v-model="authForm.firstName" type="text" autocomplete="given-name" required />
        </label>
        <label>
          Nom
          <input v-model="authForm.lastName" type="text" autocomplete="family-name" required />
        </label>
      </div>

      <label>
        Email
        <input v-model="authForm.email" type="email" autocomplete="email" required />
      </label>

      <label>
        Mot de passe
        <input v-model="authForm.password" type="password" autocomplete="current-password" required />
      </label>

      <p v-if="authError" class="checkout-error" role="alert">{{ authError }}</p>

      <button class="checkout-button" type="submit">
        {{ authMode === 'login' ? 'Se connecter' : 'Créer mon compte' }}
      </button>

      <button class="switch-auth" type="button" @click="authMode = authMode === 'login' ? 'register' : 'login'; authError = ''">
        {{ authMode === 'login' ? 'Créer un compte' : 'J’ai déjà un compte' }}
      </button>
    </form>
  </aside>

  <aside v-if="ordersOpen" class="orders-panel" aria-labelledby="orders-title">
    <div class="cart-heading">
      <div>
        <p class="eyebrow">Suivi</p>
        <h2 id="orders-title">Historique</h2>
      </div>
      <button class="close-cart" type="button" aria-label="Fermer l’historique" @click="ordersOpen = false">
        Fermer
      </button>
    </div>

    <p v-if="!orderHistory.length" class="empty-orders">
      {{ currentUser ? 'Aucune commande enregistrée pour ce compte.' : 'Aucune commande enregistrée sur cet appareil.' }}
    </p>

    <div v-else class="orders-layout">
      <ul class="orders-list">
        <li
          v-for="order in orderHistory"
          :key="order.id"
          class="order-row"
          :class="{ active: selectedOrderId === order.id }"
        >
          <button
            class="order-row-button"
            type="button"
            :aria-expanded="selectedOrderId === order.id"
            @click="openOrder(order.id)"
          >
            <span class="order-row-copy">
              <strong>Commande {{ order.id.slice(-8) }}</strong>
              <span>{{ new Date(order.created * 1000).toLocaleDateString('fr-FR') }}</span>
            </span>
            <span class="order-row-summary">
              <span class="order-status">{{ order.paymentStatus === 'paid' ? 'Payée' : order.paymentStatus }}</span>
              <strong>{{ (order.amountTotal / 100).toFixed(2).replace('.', ',') }} €</strong>
            </span>
          </button>
        </li>
      </ul>

      <div v-if="selectedOrder" class="order-detail-card">
        <div class="order-detail-heading">
          <div>
            <p class="detail-kicker">Commande {{ selectedOrder.id.slice(-8) }}</p>
            <h3>Détail de la commande</h3>
          </div>
          <span class="order-status order-status-detail">{{ selectedOrder.paymentStatus === 'paid' ? 'Payée' : selectedOrder.paymentStatus }}</span>
        </div>
        <p class="detail-meta">{{ new Date(selectedOrder.created * 1000).toLocaleString('fr-FR') }}</p>

        <ul class="order-detail-list">
          <li v-for="item in selectedOrder.items" :key="`${selectedOrder.id}-${item.name}-${item.quantity}`">
            <span class="order-item-name">{{ item.name }}</span>
            <span class="order-item-quantity">x{{ item.quantity }}</span>
            <strong>{{ ((item.amountTotal || 0) / 100).toFixed(2).replace('.', ',') }} €</strong>
          </li>
        </ul>

        <div class="order-detail-total">
          <span>Total</span>
          <strong>{{ (selectedOrder.amountTotal / 100).toFixed(2).replace('.', ',') }} €</strong>
        </div>
      </div>
    </div>
  </aside>

  <aside v-if="cartOpen" class="cart-panel" aria-labelledby="cart-title">
    <div class="cart-heading">
      <div>
        <p class="eyebrow">Votre sélection</p>
        <h2 id="cart-title">Panier</h2>
      </div>
      <button class="close-cart" type="button" aria-label="Fermer le panier" @click="cartOpen = false">
        Fermer
      </button>
    </div>

    <p v-if="!cartItems.length" class="empty-cart">Votre panier est vide.</p>

    <ul v-else class="cart-list">
      <li v-for="(item, index) in cartItems" :key="item.product.id">
        <span>{{ item.product.name }}</span>
        <strong>{{ (item.product.price * item.quantity).toFixed(2).replace('.', ',') }} €</strong>
        <div class="quantity-controls" aria-label="Modifier la quantité">
          <button type="button" aria-label="Diminuer la quantité" @click="updateQuantity(index, -1)">−</button>
          <span>{{ item.quantity }}</span>
          <button type="button" aria-label="Augmenter la quantité" @click="updateQuantity(index, 1)">+</button>
          <button type="button" aria-label="Supprimer ce produit" @click="removeProduct(index)">X</button>
        </div>
      </li>
    </ul>

    <div v-if="cartItems.length" class="cart-total">
      <span>Total</span>
      <strong>{{ cartTotal.toFixed(2).replace('.', ',') }} €</strong>
    </div>

    <p v-if="checkoutError" class="checkout-error" role="alert">{{ checkoutError }}</p>

    <button v-if="cartItems.length" class="checkout-button" type="button" @click="checkout">
      Passer la commande
    </button>
  </aside>

  <footer id="contact">
    <p>AppShop · Des essentiels pour votre setup. @ Younness Said Mohamed</p>
    <div class="social-links" aria-label="Réseaux sociaux">
      <a href="https://www.linkedin.com/in/younness-said-mohamed/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
    </div>
  </footer>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  background: #f7f3ec;
  color: #18312b;
  font-family: Georgia, 'Times New Roman', serif;
}

:global(a) {
  color: inherit;
  text-decoration: none;
}

.site-header {
  background: #f7f3ec;
  margin: 0 auto;
  max-width: 1180px;
  padding: 1.25rem 2rem 0;
  position: sticky;
  top: 0;
  z-index: 5;
}

.header-top {
  align-items: center;
  display: flex;
  justify-content: space-between;
}

.brand {
  color: #e4572e;
  font-size: 1.5rem;
  font-weight: 700;
}

.main-navigation {
  border-top: 1px solid #d6d0c6;
  display: flex;
  gap: 1.5rem;
  margin: 1.25rem auto 0;
  max-width: 1180px;
  padding: 1rem 0;
}

.main-navigation a {
  font-family: Arial, sans-serif;
  font-size: 0.85rem;
  font-weight: 700;
  text-transform: uppercase;
}

.cart-button,
.primary-button,
.account-button {
  border: 0;
  cursor: pointer;
  font-family: Arial, sans-serif;
  font-weight: 700;
}

.header-actions {
  align-items: center;
  display: flex;
  gap: 0.75rem;
}

.account-button {
  background: #18312b;
  color: #fff;
  padding: 0.55rem 0.9rem;
}

.cart-button {
  background: transparent;
  color: #18312b;
}

.cart-button span {
  background: #e4572e;
  border-radius: 50%;
  color: #fff;
  display: inline-grid;
  height: 1.5rem;
  margin-left: 0.35rem;
  place-items: center;
  width: 1.5rem;
}

.hero {
  background: #18312b;
  color: #f7f3ec;
  margin: 0 auto;
  max-width: 1180px;
  padding: 7rem 8%;
}

.eyebrow {
  color: #e4572e;
  font-family: Arial, sans-serif;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0 0 1rem;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  font-size: clamp(2.8rem, 7vw, 6.5rem);
  line-height: 0.95;
  margin-bottom: 1.5rem;
  max-width: 780px;
}

.hero-text {
  color: #d6e0d5;
  font-family: Arial, sans-serif;
  line-height: 1.6;
  max-width: 470px;
}

.primary-button {
  background: #e4572e;
  color: #fff;
  display: inline-block;
  margin-top: 1rem;
  padding: 1rem 1.4rem;
}

.products-section {
  margin: 0 auto;
  max-width: 1180px;
  padding: 5rem 2rem;
}

h2 {
  font-size: 3rem;
  margin-bottom: 0.75rem;
}

footer {
  font-family: Arial, sans-serif;
}

.products-grid {
  display: grid;
  gap: 1.5rem;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 2.5rem;
}

.orders-section {
  margin: 0 auto;
  max-width: 1180px;
  padding: 0 2rem 5rem;
}

.empty-orders {
  color: #53645c;
  font-family: Arial, sans-serif;
}

.orders-layout {
  display: grid;
  gap: 1rem;
  margin-top: 1.5rem;
}

.orders-list {
  font-family: Arial, sans-serif;
  list-style: none;
  margin: 0;
  padding: 0;
}

.orders-list li {
  border: 1px solid rgba(214, 224, 213, 0.25);
  border-radius: 0.75rem;
  margin-bottom: 0.75rem;
  overflow: hidden;
}

.order-row {
  transition: border-color 0.2s ease, background 0.2s ease;
}

.order-row.active {
  background: rgb(228 87 46 / 12%);
  border-color: #e4572e;
}

.order-row-button {
  align-items: center;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: flex;
  font: inherit;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem;
  text-align: left;
  width: 100%;
}

.order-row-button:hover,
.order-row-button:focus-visible {
  background: rgb(228 87 46 / 8%);
  outline: none;
}

.order-row-copy,
.order-row-summary {
  display: grid;
  gap: 0.25rem;
}

.order-row-summary {
  align-items: end;
  gap: 0.45rem;
  justify-items: end;
}

.orders-list li span {
  color: #d6e0d5;
  font-size: 0.85rem;
}

.order-status {
  background: rgb(220 235 217 / 16%);
  border: 1px solid rgb(220 235 217 / 35%);
  border-radius: 999px;
  color: #dcebd9;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 0.25rem 0.5rem;
  text-transform: uppercase;
}

.order-detail-card {
  background: rgb(255 255 255 / 4%);
  border: 1px solid rgba(214, 224, 213, 0.35);
  border-radius: 0.75rem;
  display: grid;
  gap: 1rem;
  padding: 1rem;
}

.order-detail-heading {
  align-items: flex-start;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
}

.detail-kicker {
  color: #e4572e;
  font-family: Arial, sans-serif;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0 0 0.35rem;
  text-transform: uppercase;
}

.order-detail-card h3 {
  margin: 0;
}

.detail-meta {
  color: #d6e0d5;
  font-family: Arial, sans-serif;
  margin: 0;
}

.order-detail-list {
  display: grid;
  gap: 0.75rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.order-detail-list li {
  align-items: center;
  border-top: 1px solid rgb(214 224 213 / 25%);
  display: grid;
  gap: 0.75rem;
  grid-template-columns: minmax(0, 1fr) auto auto;
  padding-top: 0.75rem;
}

.order-detail-list li span,
.order-detail-list li strong {
  font-family: Arial, sans-serif;
}

.order-item-name {
  min-width: 0;
}

.order-item-quantity {
  color: #d6e0d5;
  white-space: nowrap;
}

.order-status-detail {
  flex-shrink: 0;
}

.order-detail-total {
  border-top: 1px solid rgb(214 224 213 / 25%);
  display: flex;
  font-family: Arial, sans-serif;
  font-weight: 700;
  justify-content: space-between;
  padding-top: 0.75rem;
}

.product-card {
  background: #fff;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.product-image-wrapper {
  align-items: center;
  background: #e5eee4;
  display: flex;
  height: 220px;
  justify-content: center;
  overflow: hidden;
}

.product-image {
  height: 72%;
  object-fit: contain;
  transition: transform 0.25s ease;
  width: 72%;
}

.product-card:hover .product-image {
  transform: scale(1.08);
}

.product-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: 1.25rem;
}

h3 {
  font-size: 1.35rem;
  margin: 0 0 0.6rem;
}

.product-info p {
  color: #53645c;
  flex: 1;
  font-family: Arial, sans-serif;
  font-size: 0.9rem;
  line-height: 1.5;
  margin-bottom: 1.25rem;
}

.product-info strong {
  color: #e4572e;
  font-family: Arial, sans-serif;
  font-size: 1.1rem;
}

.add-button {
  background: #18312b;
  border: 0;
  color: #fff;
  cursor: pointer;
  font-family: Arial, sans-serif;
  font-weight: 700;
  margin-top: 1rem;
  padding: 0.8rem 1rem;
}

.add-button:hover {
  background: #e4572e;
}

.cart-panel {
  background: #18312b;
  color: #f7f3ec;
  height: 100vh;
  max-width: min(420px, 100vw);
  overflow-y: auto;
  padding: 2rem;
  position: fixed;
  right: 0;
  top: 0;
  width: 100%;
  z-index: 20;
}

.orders-panel {
  background: #18312b;
  color: #f7f3ec;
  height: 100vh;
  left: 0;
  max-width: min(420px, 100vw);
  overflow-y: auto;
  padding: 2rem;
  position: fixed;
  top: 0;
  width: 100%;
  z-index: 20;
}

.cart-overlay {
  background: rgb(24 49 43 / 55%);
  inset: 0;
  position: fixed;
  z-index: 10;
}

.cart-heading {
  align-items: flex-start;
  display: flex;
  justify-content: space-between;
}

.cart-heading h2 {
  margin-bottom: 0;
}

.cart-heading > strong {
  color: #d6e0d5;
  font-family: Arial, sans-serif;
  font-size: 0.9rem;
}

.close-cart {
  background: transparent;
  border: 1px solid #d6e0d5;
  color: #f7f3ec;
  cursor: pointer;
  font-family: Arial, sans-serif;
  padding: 0.45rem 0.7rem;
}

.empty-cart {
  color: #d6e0d5;
  font-family: Arial, sans-serif;
  margin: 1.5rem 0 0;
}

.auth-panel {
  background: #18312b;
  color: #f7f3ec;
  height: 100vh;
  max-width: min(440px, 100vw);
  overflow-y: auto;
  padding: 2rem;
  position: fixed;
  right: 0;
  top: 0;
  width: 100%;
  z-index: 20;
}

.auth-form {
  display: grid;
  gap: 1rem;
  margin-top: 1.5rem;
}

.auth-form label {
  display: grid;
  gap: 0.5rem;
  font-family: Arial, sans-serif;
}

.auth-form input {
  border: 1px solid #d6e0d5;
  font: inherit;
  padding: 0.75rem 0.85rem;
}

.auth-row {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.auth-email {
  color: #d6e0d5;
  font-family: Arial, sans-serif;
  margin-top: 0.25rem;
}

.auth-account {
  display: grid;
  gap: 1rem;
  margin-top: 1.5rem;
}

.switch-auth {
  background: transparent;
  border: 1px solid #d6e0d5;
  color: #f7f3ec;
  cursor: pointer;
  font-family: Arial, sans-serif;
  padding: 0.7rem 0.8rem;
}

.checkout-button {
  background: #e4572e;
  border: 0;
  color: #fff;
  cursor: pointer;
  font-family: Arial, sans-serif;
  font-weight: 700;
  margin-top: 1.5rem;
  padding: 0.9rem 1rem;
  width: 100%;
}

.order-confirmation {
  background: #dcebd9;
  color: #18312b;
  font-family: Arial, sans-serif;
  margin: 0 auto;
  max-width: 1180px;
  padding: 1rem 2rem;
}

.cart-list {
  list-style: none;
  margin: 1.5rem 0 0;
  padding: 0;
}

.cart-list li {
  align-items: center;
  border-top: 1px solid #53645c;
  display: grid;
  gap: 1rem;
  grid-template-columns: 1fr auto auto;
  padding: 1rem 0;
}

.cart-list li span,
.cart-list li strong,
.cart-list li button {
  font-family: Arial, sans-serif;
}

.cart-list li button {
  background: transparent;
  border: 1px solid #d6e0d5;
  color: #f7f3ec;
  cursor: pointer;
  padding: 0.45rem 0.7rem;
}

.quantity-controls {
  align-items: center;
  display: flex;
  gap: 0.5rem;
}

.quantity-controls button {
  align-items: center;
  display: inline-flex;
  height: 2rem;
  justify-content: center;
  padding: 0;
  width: 2rem;
}

.quantity-controls span {
  min-width: 1.25rem;
  text-align: center;
}

.cart-total {
  border-top: 1px solid #d6e0d5;
  display: flex;
  font-family: Arial, sans-serif;
  font-weight: 700;
  justify-content: space-between;
  margin-top: 0.5rem;
  padding-top: 1rem;
}

footer {
  border-top: 1px solid #d6d0c6;
  margin: 0 auto;
  max-width: 1180px;
  padding: 2rem;
}

.social-links {
  display: flex;
  gap: 1rem;
  margin-top: 0.75rem;
}

.social-links a {
  color: #e4572e;
  font-weight: 700;
}

@media (max-width: 700px) {
  .site-header {
    padding: 1.25rem 1.25rem 0;
  }

  nav {
    gap: 1rem;
    width: 100%;
  }

  .hero {
    padding: 5rem 1.5rem;
  }

  .products-section {
    padding: 4rem 1.5rem;
  }

  .products-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 480px) {
  .products-grid {
    grid-template-columns: 1fr;
  }

  .cart-panel {
    padding: 1.5rem;
  }

  .orders-panel {
    padding: 1.5rem;
  }

  .order-row-button {
    align-items: flex-start;
    padding: 0.9rem;
  }

  .order-row-summary {
    text-align: right;
  }

  .order-detail-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.75rem;
  }

  .cart-list li {
    gap: 0.5rem;
    grid-template-columns: 1fr auto;
  }

  .cart-list li button {
    grid-column: 1 / -1;
    justify-self: start;
  }
}
</style>
