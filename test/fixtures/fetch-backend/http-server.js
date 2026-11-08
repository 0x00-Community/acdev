import http from 'node:http'

http.createServer((req, res) => res.end(`node-http ${req.url}`)).listen(4100, '127.0.0.1', () => console.log('ready'))
