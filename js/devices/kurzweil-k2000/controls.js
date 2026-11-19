// K2000-specific controls built on the shared ones.

import { selectField } from '../../core/ui/controls.js';
import { CONTROL_SOURCES } from './model/tables.js';

/** Control source picker (K2000 control source numbers). */
export function sourceField(opts) {
  return selectField({ ...opts, options: CONTROL_SOURCES });
}
