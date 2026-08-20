import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export interface StubRequest {
  readonly url: string | undefined;
  readonly body: unknown;
}

export interface StubOllama {
  readonly baseUrl: string;
  readonly requests: StubRequest[];
  close(): Promise<void>;
}

export interface StubReply {
  readonly status: number;
  readonly payload: unknown;
}

/** A real HTTP server standing in for Ollama, so the adapter is exercised end to end. */
export async function stubOllama(
  handler: (body: unknown) => StubReply,
): Promise<StubOllama> {
  const requests: StubRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: req.url, body });
      const { status, payload } = handler(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}
