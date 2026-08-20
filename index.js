// backend/index.js
import 'dotenv/config';
import { createApp } from './src/app.js';
import { createProviderBundle } from './src/providers.js';

const port = Number(process.env.PORT) || 3001;

let providers;
try {
  providers = createProviderBundle();
} catch (err) {
  console.error('[boot] Failed to load provider config:', err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = createApp({ providers });

app.listen(port, () => {
  console.log(`[backend] listening on http://localhost:${port}`);
  console.log(
    `[backend] providers mode=${providers.mode} llm=${providers.config.llm.model} llmEnabled=${providers.services.llmEnabled}`,
  );
});
