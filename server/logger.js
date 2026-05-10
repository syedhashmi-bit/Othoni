'use strict';

const ts = () => new Date().toISOString();
const fmt = (lvl, args) => `[${ts()}] [${lvl}] ${args.join(' ')}`;

module.exports = {
  info: (...a) => console.log(fmt('info', a)),
  warn: (...a) => console.warn(fmt('warn', a)),
  error: (...a) => console.error(fmt('error', a)),
  debug: (...a) => {
    if (process.env.NODE_ENV !== 'production') console.log(fmt('debug', a));
  },
};
