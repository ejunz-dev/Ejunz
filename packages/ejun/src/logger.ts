import { Logger } from '@ejunz/utils/lib/utils';
export { Logger } from '@ejunz/utils/lib/utils';

global.Ejunz.Logger = Logger;
export const logger = new Logger('*');
global.Ejunz.logger = logger;
