const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========================
// FIREBASE ADMIN
// ========================
const admin = require('firebase-admin');

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!admin.apps.length && serviceAccount.project_id) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase inicializado OK');
  }
} catch(e) {
  console.error('Error Firebase:', e.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// ========================
// CREDENCIALES IZIPAY
// ========================
const IZIPAY_USER = process.env.IZIPAY_USER || '60189488';
const IZIPAY_PASSWORD = process.env.IZIPAY_PASSWORD;
const IZIPAY_API = 'https://api.micuentaweb.pe';
const IZIPAY_PUBLIC_KEY = process.env.IZIPAY_PUBLIC_KEY;
const IZIPAY_HMAC = process.env.IZIPAY_HMAC;

// ========================
// COINS POR PLAN
// ========================
const PLANES = {
  'casual':   { coins: 100,  precio: 349  },
  'cazador':  { coins: 350,  precio: 989  },
  'venganza': { coins: 1000, precio: 2489 },
  'vip':      { coins: 2500, precio: 4980 },
};

// ========================
// 1. CREAR ORDEN DE PAGO
// ========================
app.post('/crear-orden', async (req, res) => {
  const { plan, userId } = req.body;

  if (!plan || !userId || !PLANES[plan]) {
    return res.status(400).json({ error: 'Plan o userId invalido' });
  }

  const { coins, precio } = PLANES[plan];
  const orderId = 'FC-' + userId.substring(0,8) + '-' + Date.now();

  try {
    const payload = {
      amount: precio,
      currency: 'PEN',
      orderId: orderId,
      customer: { email: 'cliente@infi3les.com' },
      metadata: { userId, plan, coins: String(coins) }
    };

    const authStr = Buffer.from(IZIPAY_USER + ':' + IZIPAY_PASSWORD).toString('base64');

    const response = await axios.post(
      IZIPAY_API + '/api-payment/V4/Charge/CreatePayment',
      payload,
      { headers: { 'Authorization': 'Basic ' + authStr, 'Content-Type': 'application/json' } }
    );

    const formToken = response.data.answer && response.data.answer.formToken;

    if (!formToken) {
      return res.status(500).json({ error: 'No se obtuvo formToken', detail: response.data });
    }

    if (db) {
      await db.collection('ordenes_coins').doc(orderId).set({
        userId, plan, coins, precio,
        estado: 'pendiente',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ formToken, publicKey: IZIPAY_PUBLIC_KEY, orderId, coins, plan });

  } catch (error) {
    console.error('Error creando orden:', error.response && error.response.data || error.message);
    res.status(500).json({ error: 'Error al crear orden de pago' });
  }
});

// ========================
// 2. IPN WEBHOOK
// ========================
app.post('/ipn', async (req, res) => {
  try {
    const rawBody = JSON.stringify(req.body);
    const receivedHash = req.headers['kr-hash'];
    const computedHash = crypto.createHmac('sha256', IZIPAY_HMAC).update(rawBody).digest('hex');

    if (receivedHash !== computedHash) {
      console.warn('Firma invalida en IPN');
      return res.status(400).send('Firma invalida');
    }

    const orderStatus = req.body.orderStatus;
    const orderId = req.body.orderId;
    const metadata = req.body.metadata || {};

    if (orderStatus === 'PAID' && db) {
      const { userId, coins } = metadata;
      if (userId && coins) {
        const userRef = db.collection('usuarios_coins').doc(userId);
        await db.runTransaction(async (t) => {
          const doc = await t.get(userRef);
          const actual = doc.exists ? (doc.data().coins || 0) : 0;
          t.set(userRef, {
            coins: actual + parseInt(coins),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        });
        await db.collection('ordenes_coins').doc(orderId).update({
          estado: 'pagado',
          paidAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('Coins sumados: ' + coins + ' a usuario ' + userId);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error en IPN:', error);
    res.status(500).send('Error interno');
  }
});

// ========================
// 3. VERIFICAR COINS
// ========================
app.get('/coins/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    if (!db) return res.json({ userId, coins: 0 });
    const doc = await db.collection('usuarios_coins').doc(userId).get();
    const coins = doc.exists ? (doc.data().coins || 0) : 0;
    res.json({ userId, coins });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener coins' });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'OK', message: 'Izipay Backend funcionando' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Servidor corriendo en puerto ' + PORT);
});