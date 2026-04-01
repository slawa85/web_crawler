import pino, { type LoggerOptions } from 'pino'
import { config } from '../config.js'

// exactOptionalPropertyTypes: true means we cannot assign `undefined` to a property
// whose type does not explicitly include `undefined`. Spread the transport option
// conditionally so the key is simply absent in production rather than set to undefined.
const options: LoggerOptions = {
  level: config.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
}

export const logger = pino(options)
