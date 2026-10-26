// QuestBot: A free and open-source Discord Bot.
// Copyright(C) 2026 Vantern
// SPDX-License-Identifier: AGPL-3.0-or-later

import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import {
	type ButtonInteraction,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
} from 'discord.js';
import ms, { type StringValue } from 'ms';
import { scheduleReminder } from '#lib/reminderScheduler.js';
import { snoozeReminder } from '#lib/reminders.js';
import { emojis } from '#utils/emoji.js';

const SNOOZE_PRESETS = [
	{ label: '5 minutes', value: '5m' },
	{ label: '15 minutes', value: '15m' },
	{ label: '1 hour', value: '1h' },
	{ label: '3 hours', value: '3h' },
	{ label: '1 day', value: '1d' },
];

interface SnoozeTarget {
	reminderId: string;
	userId: string;
}

export class ReminderSnoozeHandler extends InteractionHandler {
	public constructor(ctx: InteractionHandler.LoaderContext, options: InteractionHandler.Options) {
		super(ctx, {
			...options,
			interactionHandlerType: InteractionHandlerTypes.Button,
		});
	}

	public override parse(interaction: ButtonInteraction) {
		const [action, reminderId, userId] = interaction.customId.split(':');
		if (action !== 'reminder-snooze') return this.none();

		return this.some({ reminderId, userId });
	}

	public async run(interaction: ButtonInteraction, { reminderId, userId }: SnoozeTarget) {
		if (interaction.user.id !== userId) {
			await interaction.reply({
				content: `${emojis.rightArrow2} You can't snooze others' reminders.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const modalId = `reminder-snooze-modal:${interaction.id}`;
		await interaction.showModal(
			new ModalBuilder()
				.setCustomId(modalId)
				.setTitle('Snooze reminder')
				.addLabelComponents(
					new LabelBuilder()
						.setLabel('Snooze for')
						.setStringSelectMenuComponent(
							new StringSelectMenuBuilder().setCustomId('duration').setRequired(false).addOptions(SNOOZE_PRESETS),
						),
					new LabelBuilder()
						.setLabel('Or a custom duration (max 7d)')
						.setTextInputComponent(
							new TextInputBuilder()
								.setCustomId('custom')
								.setStyle(TextInputStyle.Short)
								.setPlaceholder('2.5h')
								.setMaxLength(20)
								.setRequired(false),
						),
				),
		);

		const submitted = await interaction
			.awaitModalSubmit({ filter: (m) => m.customId === modalId, time: 120_000 })
			.catch(() => null);
		if (!submitted?.isFromMessage()) return;

		const custom = submitted.fields.getTextInputValue('custom').trim();
		const [preset] = submitted.fields.getStringSelectValues('duration');
		const input = custom || preset;
		const duration = input ? ms(input as StringValue) : undefined;

		// 7d max duration
		if (!duration || duration < 0 || duration > 604_800_000) {
			await submitted.reply({
				content: `${emojis.rightArrow2} Pick a preset or enter a duration up to 7d.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const remindAt = new Date(Date.now() + duration);
		const reminder = await snoozeReminder(reminderId, userId, remindAt);
		if (!reminder) {
			await submitted.update({ components: [] });
			await submitted.followUp({
				content: `${emojis.rightArrow2} This reminder can no longer be snoozed.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await scheduleReminder(reminder);

		const unix = Math.floor(remindAt.getTime() / 1000);
		await submitted.update({
			content: `${submitted.message.content}\n-# snoozed, reminding you again <t:${unix}:R>`,
			components: [],
		});
	}
}
