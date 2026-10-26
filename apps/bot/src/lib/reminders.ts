// QuestBot: A free and open-source Discord Bot.
// Copyright(C) 2026 Vantern
// SPDX-License-Identifier: AGPL-3.0-or-later

import { prisma } from '@questbot/database';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { LIMITS_ENABLED, LimitError } from './limits.js';

export async function createReminder(
	userId: string,
	message: string,
	remindAt: Date,
	guildId?: string,
	guildName?: string,
	channelId?: string,
) {
	if (LIMITS_ENABLED) {
		const reminderCount = await prisma.reminder.count({ where: { userId, firedAt: null } });

		if (reminderCount >= 5) {
			throw new LimitError('You can only have up to 5 reminders.');
		}
	}

	if (guildId && guildName) {
		await prisma.server.upsert({
			where: { id: guildId },
			create: { id: guildId, name: guildName },
			update: { name: guildName },
		});
		return prisma.reminder.create({
			data: { guildId, userId, channelId, message, remindAt },
		});
	}
	return prisma.reminder.create({
		data: { userId, channelId, message, remindAt },
	});
}

export async function getReminders(userId: string, guildId?: string) {
	return prisma.reminder.findMany({
		where: { userId, guildId, firedAt: null },
		orderBy: { remindAt: 'asc' },
	});
}

export async function removeReminder(reminderId: string) {
	return prisma.reminder.delete({ where: { id: reminderId } });
}

export async function clearReminders(guildId: string, userId: string) {
	return prisma.reminder.deleteMany({ where: { guildId, userId } });
}

export async function getReminder(reminderId: string) {
	return prisma.reminder.findUnique({ where: { id: reminderId } });
}

export async function claimReminder(reminderId: string, remindAt: Date) {
	const { count } = await prisma.reminder.updateMany({
		where: { id: reminderId, remindAt, firedAt: null },
		data: { firedAt: new Date() },
	});
	return count > 0;
}

export async function snoozeReminder(reminderId: string, userId: string, remindAt: Date) {
	const [reminder] = await prisma.reminder.updateManyAndReturn({
		where: { id: reminderId, userId, firedAt: { gte: new Date(Date.now() - 86_400_000) } }, // 1d window for snoozing
		data: { remindAt, firedAt: null },
	});
	return reminder ?? null;
}

export async function clearExpiredReminders() {
	return prisma.reminder.deleteMany({ where: { firedAt: { lt: new Date(Date.now() - 86_400_000) } } }); // ^ see above
}

export function buildSnoozeRow(reminderId: string, userId: string) {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`reminder-snooze:${reminderId}:${userId}`)
			.setLabel('Snooze')
			.setStyle(ButtonStyle.Secondary),
	);
}
