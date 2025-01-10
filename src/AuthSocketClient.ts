import { io as realIo, Socket as IoClientSocket, ManagerOptions, SocketOptions } from 'socket.io-client'
import { RequestedCertificateSet, SessionManager, Peer, Wallet } from '@bsv/sdk'
import { SocketClientTransport } from './SocketClientTransport.js'

/**
 * This class wraps a Socket.IO client connection with BRC-103 mutual authentication,
 * enabling secure and identity-aware communication with a server.
 */
class AuthSocketClient {
  public connected = false
  public id: string = ''
  public serverIdentityKey: string | undefined
  private eventCallbacks = new Map<string, Array<(data: any) => void>>()

  /**
   * Creates an instance of AuthSocketClient.
   *
   * @param ioSocket - The underlying Socket.IO client socket instance. 
   * @param peer - The BRC-103 Peer instance responsible for managing authenticated 
   *               communication, including message signing and verification.
   */
  constructor(
    private ioSocket: IoClientSocket,
    private peer: Peer
  ) {
    // Listen for 'connect' and 'disconnect' from underlying Socket.IO
    this.ioSocket.on('connect', () => {
      this.connected = true
      this.id = this.ioSocket.id || ''
      // Re-dispatch to dev if they've called "socket.on('connect', ...)"
      this.fireEventCallbacks('connect')
    })

    this.ioSocket.on('disconnect', (reason) => {
      this.connected = false
      // Re-dispatch
      this.fireEventCallbacks('disconnect', reason)
    })

    // Also listen for BRC-103 "general" messages
    // We'll rely on peer.listenForGeneralMessages
    this.peer.listenForGeneralMessages((senderKey, payload) => {
      this.serverIdentityKey = senderKey
      const { eventName, data } = this.decodeEventPayload(payload)
      this.fireEventCallbacks(eventName, data)
    })
  }

  on(eventName: string, callback: (data?: any) => void): AuthSocketClient {
    let arr = this.eventCallbacks.get(eventName)
    if (!arr) {
      arr = []
      this.eventCallbacks.set(eventName, arr)
    }
    arr.push(callback)
    return this
  }

  emit(eventName: string, data: any): AuthSocketClient {
    // We sign a BRC-103 "general" message and send to the server
    // via peer.toPeer
    const encoded = this.encodeEventPayload(eventName, data)
    this.peer.toPeer(encoded, this.serverIdentityKey).catch(err => {
      console.error(`BRC103IoClientSocket emit error for event "${eventName}":`, err)
    })
    return this
  }

  disconnect(): void {
    this.serverIdentityKey = undefined
    this.ioSocket.disconnect()
  }

  private fireEventCallbacks(eventName: string, data?: any) {
    const cbs = this.eventCallbacks.get(eventName)
    if (!cbs) return
    for (const cb of cbs) {
      cb(data)
    }
  }

  private encodeEventPayload(eventName: string, data: any): number[] {
    const obj = { eventName, data }
    return Array.from(Buffer.from(JSON.stringify(obj), 'utf8'))
  }

  private decodeEventPayload(payload: number[]): { eventName: string, data: any } {
    try {
      const str = Buffer.from(payload).toString('utf8')
      return JSON.parse(str)
    } catch {
      return { eventName: '_unknown', data: undefined }
    }
  }
}

/**
 * The main factory function that devs call to get a BRC-103–enabled socket.
 */
export function authIO(
  url: string,
  opts: {
    wallet: Wallet
    requestedCertificates?: RequestedCertificateSet
    sessionManager?: SessionManager
    managerOptions?: Partial<ManagerOptions & SocketOptions>
  }
): AuthSocketClient {
  // 1) Create real socket.io-client connection
  const socket = realIo(url, opts.managerOptions)

  // 2) Create a BRC-103 transport for the new socket
  const transport = new SocketClientTransport(socket)

  // 3) Create a Peer
  const peer = new Peer(
    opts.wallet,
    transport,
    opts.requestedCertificates,
    opts.sessionManager
  )

  // 4) Create our client wrapper
  return new AuthSocketClient(socket, peer)
}