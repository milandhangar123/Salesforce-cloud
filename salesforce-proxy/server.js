const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// CORS - dono origins allow karo
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://salesforce-cloud.vercel.app'
  ]
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Token exchange
app.post('/auth/token', async (req, res) => {
  try {
    const response = await axios.post(
      'https://login.salesforce.com/services/oauth2/token',
      new URLSearchParams(req.body).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// Salesforce API proxy
app.use('/sfapi', async (req, res) => {
  const instanceUrl = req.headers['x-instance-url'];
  const token = req.headers['authorization'];
  const sfPath = req.url;

  try {
    const response = await axios({
      method: req.method,
      url: `${instanceUrl}${sfPath}`,
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      data: req.body,
    });
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
});

app.listen(3001, () => console.log('Proxy running on port 3001'));