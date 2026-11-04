import { createSocket } from 'node:dgram'
try {
  createSocket('udp4').bind(5000)
  console.log('bound')
} catch (error) {
  console.log(`refused ${(error as Error).message}`)
}
