// QuestBot: A free and open-source Discord Bot.
// Copyright(C) 2026 Vantern
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Prisma, prisma } from '@questbot/database';
import type { Client } from 'discord.js';
import { emojis } from '#utils/emoji.js';
import { getShardInfo, type ShardInfo, shardOwns } from '#utils/sharding.js';
import { logger } from './logger.js';
import { createShardQueue } from './queue.js';
import { buildSnoozeRow, claimReminder } from './reminders.js';

interface ReminderJob {
	id: string;
	userId: string;
	channelId: string | null;
	message: string;
	remindAt: number;
}

function jobId(reminder: { id: string; remindAt: Date }) {
	return `${reminder.id}-${reminder.remindAt.getTime()}`;
}

let queue: ReturnType<typeof createShardQueue<ReminderJob>> | undefined;

export function initReminderScheduler(client: Client): void {
	queue = createShardQueue<ReminderJob>('reminders', client, async (job) => {
		await handleReminder(client, job.data);
	});

	reconcile(getShardInfo(client)).catch((err) => logger.error(err));
}

async function reconcile(shard: ShardInfo): Promise<void> {
	const pending = await prisma.$queryRaw<Prisma.ReminderModel[]>`
		SELECT * FROM "Reminder"
		WHERE "firedAt" IS NULL
		AND ${shardOwns(Prisma.sql`COALESCE("guildId", "userId")::bigint`, shard)}
	`;

	for (const reminder of pending) {
		await scheduleReminder(reminder);
	}
}

export async function scheduleReminder(reminder: {
	id: string;
	userId: string;
	channelId: string | null;
	message: string;
	remindAt: Date;
}): Promise<void> {
	if (!queue) return;

	const remindAt = reminder.remindAt.getTime();
	await queue.add(
		'remind',
		{ id: reminder.id, userId: reminder.userId, channelId: reminder.channelId, message: reminder.message, remindAt },
		{ jobId: jobId(reminder), delay: Math.max(0, remindAt - Date.now()), removeOnComplete: true, removeOnFail: true },
	);
}

export async function unscheduleReminder(reminder: { id: string; remindAt: Date }): Promise<void> {
	const job = await queue?.getJob(jobId(reminder));
	await job?.remove().catch(() => {});
}

async function handleReminder(client: Client, reminder: ReminderJob) {
	if (!(await claimReminder(reminder.id, new Date(reminder.remindAt)))) return;

	const payload = {
		content: `${emojis.rightArrow2} <@${reminder.userId}> reminder: ${reminder.message}`,
		allowedMentions: { users: [reminder.userId] },
		components: [buildSnoozeRow(reminder.id, reminder.userId)],
	};

	const channel = reminder.channelId ? client.channels.cache.get(reminder.channelId) : undefined;
	if (channel?.isSendable()) {
		await channel.send(payload);
		return;
	}

	const user = await client.users.fetch(reminder.userId).catch(() => null);
	await user?.send(payload).catch(() => {});
}
