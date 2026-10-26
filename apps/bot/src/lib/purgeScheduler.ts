// QuestBot: A free and open-source Discord Bot.
// Copyright(C) 2026 Vantern
// SPDX-License-Identifier: AGPL-3.0-or-later

import { logger } from './logger.js';
import { createQueue } from './queue.js';
import { clearExpiredReminders } from './reminders.js';
import { purgeDeletedServers } from './servers.js';
import { purgeExpiredWarns } from './warns.js';

export function initPurgeScheduler(): void {
	const queue = createQueue('purge', async () => {
		await purgeExpiredWarns();
		await purgeDeletedServers();
		await clearExpiredReminders();
	});

	queue
		.upsertJobScheduler('daily-purge', { pattern: '0 3 * * *' }, { name: 'purge' }) // 3am purge
		.catch((err) => logger.error(err));
}
