// QuestBot: A free and open-source Discord Bot.
// Copyright(C) 2026 Vantern
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Listener } from '@sapphire/framework';
import { AuditLogEvent, Colors, EmbedBuilder, Events, type GuildMember } from 'discord.js';
import { removeAfk } from '#lib/afk.js';
import { logger } from '#lib/logger.js';
import { getRecentAuditLogEntry, logEmbed } from '#lib/logging.js';
import { unscheduleReminder } from '#lib/reminderScheduler.js';
import { clearReminders, getReminders } from '#lib/reminders.js';

export class GuildMemberRemoveListener extends Listener<typeof Events.GuildMemberRemove> {
	public constructor(context: Listener.LoaderContext, options: Listener.Options) {
		super(context, {
			...options,
			event: Events.GuildMemberRemove,
		});
	}

	public async run(member: GuildMember) {
		// cleanup old data when a user leaves
		const reminders = await getReminders(member.id, member.guild.id);
		await Promise.all([
			removeAfk(member.guild.id, member.id).catch((err) => logger.error(err)),
			clearReminders(member.guild.id, member.id).catch((err) => logger.error(err)),
			...reminders.map((reminder) => unscheduleReminder(reminder).catch((err) => logger.error(err))),
		]);

		const banEntry = await getRecentAuditLogEntry(member.guild, AuditLogEvent.MemberBanAdd, member.id);
		if (banEntry) return;

		const kickEntry = await getRecentAuditLogEntry(member.guild, AuditLogEvent.MemberKick, member.id);

		const embed = new EmbedBuilder()
			.setTitle(kickEntry ? 'Member Kicked' : 'Member Left')
			.setColor(kickEntry ? 0xff6962 : Colors.Grey)
			.addFields(
				{ name: 'Member', value: `${member.user.tag} (${member.id})`, inline: false },
				{ name: 'Username', value: member.user.toString(), inline: true },
			)
			.setTimestamp();

		if (kickEntry?.executor) {
			embed.addFields({ name: 'Moderator', value: `<@${kickEntry.executor.id}>`, inline: true });
		}

		if (kickEntry?.reason) {
			embed.addFields({ name: 'Reason', value: kickEntry.reason, inline: false });
		}

		await logEmbed(member.guild, embed);
	}
}
