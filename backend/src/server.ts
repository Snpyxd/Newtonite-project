import { createApp } from './app';
import { config } from './config';

const server = createApp().listen(config.port, () => console.log(`API listening on :${config.port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
