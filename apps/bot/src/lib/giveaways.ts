// QuestBot: A free and open-source Discord Bot.
// Copyright(C) 2026 Vantern
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomInt } from 'node:crypto';
import { type Prisma, prisma } from '@questbot/database';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, EmbedBuilder } from 'discord.js';
import { Colors } from '#utils/embeds.js';
import { getChannel } from '#utils/getChannel.js';

type GiveawayView = Prisma.GiveawayModel;

export function formatWinnersLine(winnerIds: string[]): string {
	return winnerIds.length ? winnerIds.map((id) => `<@${id}>`).join(', ') : 'No valid entries.';
}

export function buildGiveawayEmbed(giveaway: GiveawayView): EmbedBuilder {
	const unix = Math.floor(giveaway.endsAt.getTime() / 1000);
	const entriesLine =
		giveaway.maxEntries !== null ? `${giveaway.entries.length}/${giveaway.maxEntries}` : `${giveaway.entries.length}`;

	if (giveaway.ended) {
		const winnersLine = formatWinnersLine(giveaway.winnerIds);

		return new EmbedBuilder()
			.setColor(Colors.success)
			.setTitle('Giveaway Ended')
			.setDescription(
				[
					`**Prize:** ${giveaway.prize}`,
					`**Winner(s):** ${winnersLine}`,
					`**Hosted by:** <@${giveaway.hostId}>`,
					`**Entries:** ${entriesLine}`,
				].join('\n'),
			);
	}

	return new EmbedBuilder()
		.setColor(Colors.info)
		.setTitle('Giveaway')
		.setDescription(
			[
				`**Prize:** ${giveaway.prize}`,
				`**Winners:** ${giveaway.winnerCount}`,
				`**Ends:** <t:${unix}:R>`,
				`**Hosted by:** <@${giveaway.hostId}>`,
				`**Entries:** ${entriesLine}`,
				`\nClick the button below to enter!`,
			].join('\n'),
		);
}

export function buildGiveawayComponents(giveaway: GiveawayView) {
	const isFull = giveaway.maxEntries !== null && giveaway.entries.length >= giveaway.maxEntries;

	const button = new ButtonBuilder()
		.setCustomId(`giveaway-enter-${giveaway.id}`)
		.setLabel('Enter')
		.setEmoji('🎉')
		.setStyle(ButtonStyle.Primary)
		.setDisabled(giveaway.ended || isFull);

	return [new ActionRowBuilder<ButtonBuilder>().addComponents(button)];
}

export async function refreshGiveawayMessage(client: Client, giveaway: GiveawayView) {
	if (!giveaway.messageId) return;

	const channel = await getChannel(client.channels, giveaway.channelId);
	if (!channel?.isTextBased()) return;

	const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
	if (!message) return;

	await message
		.edit({ embeds: [buildGiveawayEmbed(giveaway)], components: buildGiveawayComponents(giveaway) })
		.catch(() => {});
}

export class AlreadyEnteredError extends Error {
	public constructor() {
		super('You have already entered this giveaway.');
		this.name = 'AlreadyEnteredError';
	}
}

// this happens when a user attempts to leave a giveaway they haven't entered with an old (ephemeral) button
export class NotEnteredError extends Error {
	public constructor() {
		super("You haven't entered this giveaway.");
		this.name = 'NotEnteredError';
	}
}

export class GiveawayFullError extends Error {
	public constructor() {
		super("This giveaway is full, it has reached it's maximum number of entries.");
		this.name = 'GiveawayFullError';
	}
}

export async function createGiveaway(
	guildId: string,
	guildName: string,
	channelId: string,
	hostId: string,
	prize: string,
	endsAt: Date,
	maxEntries?: number,
	winnerCount?: number,
) {
	await prisma.server.upsert({
		where: { id: guildId },
		create: { id: guildId, name: guildName },
		update: { name: guildName },
	});

	return prisma.giveaway.create({
		data: { guildId, channelId, hostId, prize, endsAt, maxEntries, winnerCount },
	});
}

export async function setGiveawayMessageId(giveawayId: string, messageId: string) {
	return prisma.giveaway.update({ where: { id: giveawayId }, data: { messageId } });
}

export async function getGiveaway(giveawayId: string) {
	return prisma.giveaway.findUnique({ where: { id: giveawayId } });
}

export async function getGiveawayByMessageId(guildId: string, messageId: string) {
	const giveaway = await prisma.giveaway.findUnique({ where: { messageId } });
	if (!giveaway || giveaway.guildId !== guildId) return null;
	return giveaway;
}

export async function deleteGiveawayByMessageId(messageId: string) {
	await prisma.giveaway.deleteMany({ where: { messageId } });
}

export async function deleteGiveawaysByMessageIds(messageIds: string[]) {
	if (messageIds.length === 0) return;

	await prisma.giveaway.deleteMany({ where: { messageId: { in: messageIds } } });
}

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function lockGiveawayRow(tx: TransactionClient, giveawayId: string): Promise<void> {
	await tx.$executeRaw`SELECT id FROM "giveaways" WHERE id = ${giveawayId} FOR UPDATE`;
}

export async function enterGiveaway(giveawayId: string, userId: string) {
	return prisma.$transaction(async (tx) => {
		await lockGiveawayRow(tx, giveawayId);

		const giveaway = await tx.giveaway.findUnique({ where: { id: giveawayId } });
		if (!giveaway || giveaway.ended) return null;

		if (giveaway.entries.includes(userId)) {
			throw new AlreadyEnteredError();
		}

		if (giveaway.maxEntries !== null && giveaway.entries.length >= giveaway.maxEntries) {
			throw new GiveawayFullError();
		}

		return tx.giveaway.update({
			where: { id: giveawayId },
			data: { entries: { push: userId } },
		});
	});
}

export async function leaveGiveaway(giveawayId: string, userId: string) {
	return prisma.$transaction(async (tx) => {
		await lockGiveawayRow(tx, giveawayId);

		const giveaway = await tx.giveaway.findUnique({ where: { id: giveawayId } });
		if (!giveaway || giveaway.ended) return null;

		if (!giveaway.entries.includes(userId)) {
			throw new NotEnteredError();
		}

		return tx.giveaway.update({
			where: { id: giveawayId },
			data: { entries: giveaway.entries.filter((id) => id !== userId) },
		});
	});
}

export async function deleteGiveaway(giveawayId: string) {
	return prisma.giveaway.delete({ where: { id: giveawayId } });
}

export type FinishGiveawayResult =
	| { status: 'ended'; giveaway: GiveawayView }
	| { status: 'already-ended' }
	| { status: 'not-found' };

export async function finishGiveaway(giveawayId: string): Promise<FinishGiveawayResult> {
	return prisma.$transaction(async (tx) => {
		await lockGiveawayRow(tx, giveawayId);

		const giveaway = await tx.giveaway.findUnique({ where: { id: giveawayId } });
		if (!giveaway) return { status: 'not-found' };
		if (giveaway.ended) return { status: 'already-ended' };

		const winnerIds = pickWinners(giveaway.entries, giveaway.winnerCount);
		const updated = await tx.giveaway.update({
			where: { id: giveawayId },
			data: { ended: true, winnerIds },
		});

		return { status: 'ended', giveaway: updated };
	});
}

export type RerollGiveawayResult =
	| { status: 'rerolled'; giveaway: GiveawayView }
	| { status: 'not-ended' }
	| { status: 'no-entries' }
	| { status: 'not-found' };

export async function rerollGiveawayWinners(giveawayId: string, count?: number): Promise<RerollGiveawayResult> {
	return prisma.$transaction(async (tx) => {
		await lockGiveawayRow(tx, giveawayId);

		const giveaway = await tx.giveaway.findUnique({ where: { id: giveawayId } });
		if (!giveaway) return { status: 'not-found' };
		if (!giveaway.ended) return { status: 'not-ended' };

		const previousWinners = new Set(giveaway.winnerIds);
		const pool = giveaway.entries.filter((id) => !previousWinners.has(id));
		if (pool.length === 0) return { status: 'no-entries' };

		const winnerIds = pickWinners(pool, count ?? giveaway.winnerCount);
		const updated = await tx.giveaway.update({
			where: { id: giveawayId },
			data: { winnerIds },
		});

		return { status: 'rerolled', giveaway: updated };
	});
}

export function pickWinners(entries: string[], count: number): string[] {
	const pool = [...entries];
	const winners: string[] = [];

	while (winners.length < count && pool.length > 0) {
		const index = randomInt(pool.length);
		winners.push(pool[index]!);
		pool.splice(index, 1);
	}

	return winners;
}
