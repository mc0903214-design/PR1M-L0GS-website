const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const SMM_API_KEY = process.env.SMM_API_KEY; // Put your SMM provider API key in your environment variables
const SMM_API_URL = process.env.SMM_API_URL || 'https://reseller-provider-domain.com/api/v2'; // Replace with provider API endpoint

// Fetch all available services
app.get('/api/smm/services', async (req, res) => {
    try {
        const response = await axios.post(SMM_API_URL, new URLSearchParams({
            key: SMM_API_KEY,
            action: 'services'
        }));
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch services' });
    }
});

// Create an SMM order
app.post('/api/smm/order', async (req, res) => {
    const { service, link, quantity } = req.body;
    try {
        const response = await axios.post(SMM_API_URL, new URLSearchParams({
            key: SMM_API_KEY,
            action: 'add',
            service: service,
            link: link,
            quantity: quantity
        }));
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: 'Order submission failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
