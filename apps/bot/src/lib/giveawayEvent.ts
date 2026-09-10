// QuestBot: A free and open-source Discord Bot.
// Copyright(C) 2026 Vantern
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Prisma, prisma } from '@questbot/database';
import type { Client } from 'discord.js';
import { getChannel } from '#utils/getChannel.js';
import { getShardInfo, type ShardInfo, shardOwns } from '#utils/sharding.js';
import {
	buildGiveawayEmbed,
	type FinishGiveawayResult,
	finishGiveaway,
	formatWinnersLine,
	type RerollGiveawayResult,
	rerollGiveawayWinners,
} from './giveaways.js';
import { logger } from './logger.js';
import { createShardQueue } from './queue.js';

interface GiveawayJob {
	id: string;
}

let queue: ReturnType<typeof createShardQueue<GiveawayJob>> | undefined;

export function giveawayScheduler(client: Client): void {
	queue = createShardQueue<GiveawayJob>('giveaways', client, async (job) => {
		await endGiveaway(client, job.data.id);
	});

	reconcile(getShardInfo(client)).catch((err) => logger.error(err));
}

async function reconcile(shard: ShardInfo): Promise<void> {
	const pending = await prisma.$queryRaw<Prisma.GiveawayModel[]>`
		SELECT * FROM "giveaways"
		WHERE "ended" = false
			AND ${shardOwns(Prisma.sql`"guildId"::bigint`, shard)}
	`;

	for (const giveaway of pending) {
		await scheduleGiveawayEnd(giveaway);
	}
}

export async function scheduleGiveawayEnd(giveaway: { id: string; endsAt: Date }): Promise<void> {
	if (!queue) return;

	await unscheduleGiveawayEnd(giveaway.id);

	const delay = Math.max(0, giveaway.endsAt.getTime() - Date.now());
	await queue.add(
		'end',
		{ id: giveaway.id },
		{ jobId: giveaway.id, delay, removeOnComplete: true, removeOnFail: true },
	);
}

export async function unscheduleGiveawayEnd(giveawayId: string): Promise<void> {
	const job = await queue?.getJob(giveawayId);
	await job?.remove().catch(() => {});
}

async function announceGiveawayOutcome(
	client: Client,
	giveaway: Prisma.GiveawayModel,
	content: string,
	mentionUsers: string[],
): Promise<void> {
	const channel = await getChannel(client.channels, giveaway.channelId);
	if (!channel?.isSendable()) return;

	const editMessage = giveaway.messageId
		? channel.messages
				.fetch(giveaway.messageId)
				.then((message) => message.edit({ embeds: [buildGiveawayEmbed(giveaway)], components: [] }))
				.catch(() => {})
		: Promise.resolve();

	const sendAnnouncement = channel
		.send({
			content,
			allowedMentions: { users: mentionUsers },
			...(giveaway.messageId ? { reply: { messageReference: giveaway.messageId } } : {}),
		})
		.catch((err) => logger.error(err));

	await Promise.all([editMessage, sendAnnouncement]);
}

export async function endGiveaway(client: Client, giveawayId: string): Promise<FinishGiveawayResult> {
	await unscheduleGiveawayEnd(giveawayId);

	const result = await finishGiveaway(giveawayId);
	if (result.status !== 'ended') return result;

	const ended = result.giveaway;
	const content = ended.winnerIds.length
		? `Congratulations ${formatWinnersLine(ended.winnerIds)}! You've won **${ended.prize}**!`
		: `The giveaway for **${ended.prize}** ended with no entries.`;

	await announceGiveawayOutcome(client, ended, content, ended.winnerIds);

	return result;
}

export async function rerollGiveaway(
	client: Client,
	giveawayId: string,
	count?: number,
): Promise<RerollGiveawayResult> {
	const result = await rerollGiveawayWinners(giveawayId, count);
	if (result.status !== 'rerolled') return result;

	const giveaway = result.giveaway;
	const content = `New winner(s) for **${giveaway.prize}**: ${formatWinnersLine(giveaway.winnerIds)}!`;

	await announceGiveawayOutcome(client, giveaway, content, giveaway.winnerIds);

	return result;
}
