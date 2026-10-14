// QuestBot: A free and open-source Discord Bot.
// Copyright(C) 2026 Vantern
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Command } from '@sapphire/framework';
import {
	MessageFlags,
	type SlashCommandBuilder,
	type SlashCommandStringOption,
	type SlashCommandSubcommandBuilder,
} from 'discord.js';
import ms, { type StringValue } from 'ms';
import { containsBlockedWord } from '#lib/automod.js';
import { LimitError } from '#lib/limits.js';
import { logger } from '#lib/logger.js';
import { scheduleReminder, unscheduleReminder } from '#lib/reminderScheduler.js';
import { createReminder, getReminder, removeReminder } from '#lib/reminders.js';
import { errorEmbed, infoEmbed, successEmbed } from '#utils/embeds.js';
import { emojis } from '#utils/emoji.js';

export class ReminderCommand extends Command {
	public constructor(context: Command.LoaderContext, options: Command.Options) {
		super(context, { ...options, preconditions: ['devMode'] });
	}

	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder: SlashCommandBuilder) =>
			builder
				.setName('reminder')
				.setDescription('Set reminders!')
				.addSubcommand((subcommand: SlashCommandSubcommandBuilder) =>
					subcommand
						.setName('add')
						.setDescription('Set a new reminder.')
						.addStringOption((option: SlashCommandStringOption) =>
							option.setName('duration').setDescription('When to remind you').setRequired(true).setMaxLength(20),
						)
						.addStringOption((option: SlashCommandStringOption) =>
							option.setName('message').setDescription('What to remind you about').setRequired(true).setMaxLength(1000),
						),
				)
				.addSubcommand((subcommand: SlashCommandSubcommandBuilder) =>
					subcommand
						.setName('remove')
						.setDescription('Cancel a reminder.')
						.addStringOption((option: SlashCommandStringOption) =>
							option.setName('id').setDescription('The reminder ID').setRequired(true).setMaxLength(36),
						),
				),
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		const subcommand = interaction.options.getSubcommand();

		if (subcommand === 'add') {
			const durationStr = interaction.options.getString('duration', true);
			const message = interaction.options.getString('message', true);

			const duration = ms(durationStr as StringValue);
			if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
				await interaction.reply({
					embeds: [errorEmbed(`${emojis.rightArrow2} Invalid duration.`)],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (duration > 31_536_000_000) {
				await interaction.reply({
					embeds: [errorEmbed(`${emojis.rightArrow2} Reminder cannot be longer than 1 year.`)],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (interaction.inCachedGuild() && (await containsBlockedWord(interaction.guild.id, message))) {
				await interaction.reply({
					embeds: [errorEmbed(`${emojis.rightArrow2} That reminder contains a word blocked by this server.`)],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const remindAt = new Date(Date.now() + duration);

			try {
				const reminder = interaction.inCachedGuild()
					? await createReminder(
							interaction.user.id,
							message,
							remindAt,
							interaction.guild.id,
							interaction.guild.name,
							interaction.channelId,
						)
					: await createReminder(interaction.user.id, message, remindAt);

				await scheduleReminder(reminder);

				const unix = Math.floor(remindAt.getTime() / 1000);
				await interaction.reply({
					embeds: [
						infoEmbed(
							`${emojis.rightArrow2} Reminder set to go off in <t:${unix}:R>. Message: ${message}\nID: \`${reminder.id}\``,
						),
					],
					allowedMentions: { parse: [] },
				});
				return;
			} catch (err) {
				logger.error(err);
				if (err instanceof LimitError) {
					await interaction.reply({
						embeds: [errorEmbed(`${emojis.rightArrow2} ${err.message}`)],
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				throw err;
			}
		}

		if (subcommand === 'remove') {
			const id = interaction.options.getString('id', true);
			const reminder = await getReminder(id);

			if (!reminder) {
				await interaction.reply({
					embeds: [errorEmbed(`${emojis.rightArrow2} No reminder found.`)],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (reminder.userId !== interaction.user.id) {
				await interaction.reply({
					embeds: [errorEmbed(`${emojis.rightArrow2} You can't remove others' reminders.`)],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await removeReminder(id);
			await unscheduleReminder(reminder);
			await interaction.reply({
				embeds: [successEmbed(`${emojis.rightArrow2} Reminder removed.`)],
				flags: MessageFlags.Ephemeral,
			});

			setTimeout(() => {
				interaction.deleteReply().catch(() => {});
			}, 5000);
			return;
		}
	}
}
