import postgres from 'postgres';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
// Initialise postgres.js connection pool.
// Tagged-template sql tag is exported for use in all DB modules.
let sqlInstance = null;
function createSql() {
    return postgres(config.databaseUrl, {
        max: config.workerCount + 5, // pool size scales with worker count, +5 for background jobs
        idle_timeout: 30, // release idle connections after 30s
        connect_timeout: 10,
        onnotice: (notice) => {
            logger.debug({ notice }, 'postgres notice');
        },
    });
}
export function getSql() {
    if (sqlInstance === null) {
        sqlInstance = createSql();
    }
    return sqlInstance;
}
export async function closeDb() {
    if (sqlInstance !== null) {
        await sqlInstance.end();
        sqlInstance = null;
        logger.info('Database connection closed');
    }
}
//# sourceMappingURL=connection.js.map