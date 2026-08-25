// backend/index.js
import 'dotenv/config';
import { createApp } from './src/app.js';
import { createProviderBundle } from './src/providers.js';

const port = Number(process.env.PORT) || 3001;

let providers;
let app;
try {
  providers = createProviderBundle();
  app = createApp({ providers });
} catch (err) {
  console.error('[boot] Invalid server configuration:', err instanceof Error ? err.message : 'Unknown error');
  process.exit(1);
}

app.listen(port, () => {
  console.log(`[backend] listening on http://localhost:${port}`);
  console.log(
    `[backend] providers mode=${providers.mode} llm=${providers.config.llm.model} llmEnabled=${providers.services.llmEnabled} speechEnabled=${providers.services.speechEnabled}`,
  );
});
