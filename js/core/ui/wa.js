// Web Awesome (vendor/webawesome, MIT): the components the app uses, loaded from the app's own files
// (no CDN, so it works offline and in the desktop app), and the bundled Font Awesome Free icons.
// Loaded by index.html before the app starts; core/ui/dom.js only creates the elements, so the
// views still render in Node's test DOM without this module.

import { setBasePath, setIconPath } from '../../../vendor/webawesome/utilities/base-path.js';
import '../../../vendor/webawesome/components/icon/icon.js';
import '../../../vendor/webawesome/components/dialog/dialog.js';
import '../../../vendor/webawesome/components/toast/toast.js';
import '../../../vendor/webawesome/components/toast-item/toast-item.js';
import '../../../vendor/webawesome/components/tab-group/tab-group.js';
import '../../../vendor/webawesome/components/tab/tab.js';
import '../../../vendor/webawesome/components/badge/badge.js';
import '../../../vendor/webawesome/components/callout/callout.js';
import '../../../vendor/webawesome/components/popup/popup.js';
import '../../../vendor/webawesome/components/spinner/spinner.js';
import '../../../vendor/webawesome/components/divider/divider.js';
import '../../../vendor/webawesome/components/switch/switch.js';
import '../../../vendor/webawesome/components/radio-group/radio-group.js';
import '../../../vendor/webawesome/components/radio/radio.js';
import { installTooltips } from './tooltips.js';

const vendor = (p) => new URL(`../../../vendor/${p}`, import.meta.url).href.replace(/\/$/, '');
setBasePath(vendor('webawesome'));
setIconPath(vendor('icons')); // <wa-icon name="gear"> -> vendor/icons/solid/gear.svg
installTooltips();
