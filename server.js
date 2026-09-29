require('dotenv').config();
const dns = require('node:dns');

const dnsServers = process.env.DNS_SERVERS?.split(',').map((server) => server.trim()).filter(Boolean);
if (dnsServers?.length) dns.setServers(dnsServers);

const app = require('./src/app');
const connectDB = require('./src/config/db');

const PORT = process.env.PORT || 5000;

(async () => {
    try {
        if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not defined');
        await connectDB();
        const server = app.listen(PORT, () =>
            console.log(`Server is running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`)
        );
        process.on('unhandledRejection', (err) => {
            console.error('Unhandled rejection:', err);
            server.close(() => process.exit(1));
        });
    } catch (err) {
        console.error('Startup failed:', err.message);
        process.exit(1);
    }
})();
