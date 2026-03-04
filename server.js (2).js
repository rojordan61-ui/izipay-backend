const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Firebase Admin
const admin = require('firebase-admin');
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!admin.apps.length && serviceAccount.project_id) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('Firebase inicializado OK');
  }
} catch(e) { console.error('Error Firebase:', e.message); }
const db = admin.apps.length ? admin.firestore() : null;

// Credenciales Izipay
const IZIPAY_USER = process.env.IZIPAY_USER || '60189488';
const IZIPAY_PASSWORD = process.env.IZIPAY_PASSWORD;
const IZIPAY_API = 'https://api.micuentaweb.pe';
const IZIPAY_PUBLIC_KEY = process.env.IZIPAY_PUBLIC_KEY;
const IZIPAY_HMAC = process.env.IZIPAY_HMAC;

const PLANES = {
  'casual':   { coins: 50,   precio: 289  },
  'cazador':  { coins: 170,  precio: 749  },
  'venganza': { coins: 450,  precio: 1489 },
  'vip':      { coins: 1000, precio: 2450 },
};

app.post('/crear-orden', async (req, res) => {
  const { plan, userId } = req.body;
  if (!plan || !userId || !PLANES[plan]) return res.status(400).json({ error: 'Plan o userId invalido' });
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
    console.log('Creando orden:', orderId, 'plan:', plan, 'monto:', precio);
    const response = await axios.post(
      IZIPAY_API + '/api-payment/V4/Charge/CreatePayment',
      payload,
      { headers: { 'Authorization': 'Basic ' + authStr, 'Content-Type': 'application/json' } }
    );
    console.log('Respuesta Izipay status:', response.data.status);
    const formToken = response.data.answer && response.data.answer.formToken;
    if (!formToken) return res.status(500).json({ error: 'No se obtuvo formToken', detail: response.data });
    if (db) {
      await db.collection('ordenes_coins').doc(orderId).set({
        userId, plan, coins, precio, estado: 'pendiente',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    res.json({ formToken, publicKey: IZIPAY_PUBLIC_KEY, orderId, coins, plan });
  } catch (error) {
    const errData = error.response && error.response.data;
    console.error('Error creando orden:', JSON.stringify(errData) || error.message);
    res.status(500).json({ error: 'Error al crear orden', detail: errData });
  }
});

app.post('/ipn', async (req, res) => {
  try {
    const rawBody = JSON.stringify(req.body);
    const receivedHash = req.headers['kr-hash'];
    const computedHash = crypto.createHmac('sha256', IZIPAY_HMAC).update(rawBody).digest('hex');
    if (receivedHash !== computedHash) return res.status(400).send('Firma invalida');
    const { orderStatus, orderId, metadata } = req.body;
    if (orderStatus === 'PAID' && db) {
      const { userId, coins } = metadata || {};
      if (userId && coins) {
        const userRef = db.collection('usuarios_coins').doc(userId);
        await db.runTransaction(async (t) => {
          const doc = await t.get(userRef);
          const actual = doc.exists ? (doc.data().coins || 0) : 0;
          t.set(userRef, { coins: actual + parseInt(coins), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        });
        await db.collection('ordenes_coins').doc(orderId).update({ estado: 'pagado', paidAt: admin.firestore.FieldValue.serverTimestamp() });
        console.log('Coins sumados:', coins, 'a usuario:', userId);
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error IPN:', error);
    res.status(500).send('Error interno');
  }
});

app.get('/coins/:userId', async (req, res) => {
  try {
    if (!db) return res.json({ coins: 0 });
    const doc = await db.collection('usuarios_coins').doc(req.params.userId).get();
    res.json({ coins: doc.exists ? (doc.data().coins || 0) : 0 });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/', (req, res) => res.json({ status: 'OK' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor en puerto ' + PORT));
