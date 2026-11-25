import { createApp } from './app';

const app = await createApp();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1') });
process.once('SIGTERM', () => void app.close().finally(() => process.exit(0)));
process.once('SIGINT', () => void app.close().finally(() => process.exit(0)));
