import { createLibraryServer } from './server.js';

const PORT = Number(process.env.PORT) || 3300;
const LIBRARY_PATH = process.env.LIBRARY_PATH || '/library';
const RESCAN_INTERVAL_MINUTES = Number(process.env.LIBRARY_RESCAN_INTERVAL_MINUTES) || 0;

async function main() {
  const { app, rescan } = createLibraryServer({ libraryRoot: LIBRARY_PATH });

  console.log(`[library-server] scanning ${LIBRARY_PATH} ...`);
  await rescan();

  if (RESCAN_INTERVAL_MINUTES > 0) {
    setInterval(
      () => {
        rescan().catch((err) => console.error('[library-server] periodic rescan failed:', err));
      },
      RESCAN_INTERVAL_MINUTES * 60 * 1000
    );
    console.log(`[library-server] periodic rescan every ${RESCAN_INTERVAL_MINUTES} minute(s)`);
  }

  app.listen(PORT, () => {
    console.log(`[library-server] listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('[library-server] fatal error during startup:', err);
  process.exit(1);
});
