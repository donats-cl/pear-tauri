import { initAdblock } from './features/adblock';
import { initHideComments } from './features/hide-comments';
import { initAlbumColor } from './features/album-color';
import { initLyrics } from './features/lyrics';
import { initAmbientMode } from './features/ambient-mode';
import { initDiscordRpc } from './features/discord-rpc';
import { initHideUpgrade } from './features/hide-upgrade';
import { initSamples } from './features/samples';
import { initPlayerQuality } from './features/player-quality';
import { initHistory } from './features/history';
import { initHistoryPage } from './features/history-page';

// Adblock should run as early as possible
initAdblock();
initHideComments();
initAlbumColor();
initLyrics();
// значения по умолчанию; сохранённые пользователем настройки имеют приоритет
initAmbientMode({ config: { blur: 120, opacity: 0.8, size: 120 } });
initDiscordRpc();
initHideUpgrade();
initSamples();
initPlayerQuality();
initHistory();
initHistoryPage();

console.log('[Pear] Injection bundle loaded');
