import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export type Opener = (port: number) => Promise<Duplex>

export class Forward {
  readonly port: number
  readonly guest: number
  readonly closed: Promise<void>
  readonly #server: Server

  private constructor(server: Server, port: number, guest: number) {
    this.#server = server
    this.port = port
    this.guest = guest
    this.closed = new Promise((done) => server.once('close', () => done()))
  }

  static async open(guest: number, opener?: Opener): Promise<Forward> {
    const open = opener ?? (await Forward.#devd())
    const server = createServer((socket) => Forward.#join(socket, open(guest)))
    await new Promise<void>((listening, failed) => {
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed)
        listening()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('forward: the local listener has no port')
    return new Forward(server, address.port, guest)
  }

  static async #devd(): Promise<Opener> {
    const { Machine } = await import('./machine.ts')
    const devd = new Machine().devd()
    return (port) => devd.tcp(port)
  }

  static #join(socket: Socket, opening: Promise<Duplex>): void {
    socket.pause()
    socket.on('error', () => socket.destroy())
    opening.then(
      (tunnel) => {
        tunnel.on('error', () => socket.destroy())
        socket.on('close', () => tunnel.destroy())
        tunnel.on('close', () => socket.destroy())
        socket.pipe(tunnel)
        tunnel.pipe(socket)
        socket.resume()
      },
      () => socket.destroy(),
    )
  }

  close(): void {
    this.#server.close()
  }
}
