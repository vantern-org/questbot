// QuestBot: A free and open-source Discord Bot.
// Copyright(C) 2026 Vantern
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Prisma } from '@questbot/database';
import { Command } from '@sapphire/framework';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Guild,
	type GuildMember,
	type Message,
	type MessageComponentInteraction,
	MessageFlags,
	messageLink,
	PermissionFlagsBits,
	PermissionsBitField,
	type SlashCommandBuilder,
	type SlashCommandIntegerOption,
	type SlashCommandStringOption,
	type SlashCommandSubcommandBuilder,
	TextInputBuilder,
	TextInputStyle,
} from 'discord.js';
import ms, { type StringValue } from 'ms';
import { containsBlockedWord } from '#lib/automod.js';
import { endGiveaway, rerollGiveaway, scheduleGiveawayEnd, unscheduleGiveawayEnd } from '#lib/giveawayEvent.js';
import {
	buildGiveawayComponents,
	buildGiveawayEmbed,
	createGiveaway,
	deleteGiveaway,
	formatWinnersLine,
	getGiveawayByMessageId,
	searchGuildGiveaways,
	setGiveawayMessageId,
} from '#lib/giveaways.js';
import { logger } from '#lib/logger.js';
import { truncate } from '#lib/logging.js';
import { awaitMessageComponentSafe } from '#utils/collectors.js';
import { errorEmbed, infoEmbed, successEmbed } from '#utils/embeds.js';
import { emojis } from '#utils/emoji.js';
import { getChannel } from '#utils/getChannel.js';
import { promptForModalInput } from '#utils/modals.js';

const MAX_DURATION = ms('30d');

interface ViewEntry {
	userId: string;
	position: number;
}

async function searchEntries(guild: Guild, entries: ViewEntry[], query: string): Promise<ViewEntry[]> {
	const entryIds = new Set(entries.map((entry) => entry.userId));
	if (entryIds.has(query)) return entries.filter((entry) => entry.userId === query);

	const matches = new Set<string>();

	const fetched = await guild.members.fetch({ query, limit: 100, time: 10_000 }).catch(() => null);
	for (const member of fetched?.values() ?? []) {
		if (entryIds.has(member.id)) matches.add(member.id);
	}

	const lowered = query.toLowerCase();
	for (const entry of entries) {
		const member = guild.members.cache.get(entry.userId);
		if (!member) continue;
		if (member.displayName.toLowerCase().includes(lowered) || member.user.username.toLowerCase().includes(lowered)) {
			matches.add(entry.userId);
		}
	}

	return entries.filter((entry) => matches.has(entry.userId));
}

function buildViewEmbed(
	giveaway: Prisma.GiveawayModel,
	shown: ViewEntry[],
	page: number,
	totalPages: number,
	query: string | null,
) {
	const unix = Math.floor(giveaway.endsAt.getTime() / 1000);
	const entriesCount =
		giveaway.maxEntries !== null ? `${giveaway.entries.length}/${giveaway.maxEntries}` : `${giveaway.entries.length}`;

	const info = [
		`**Prize:** ${giveaway.prize}`,
		`**Status:** ${giveaway.ended ? `Ended <t:${unix}:R>` : `Active, ends <t:${unix}:R>`}`,
		`**Hosted by:** <@${giveaway.hostId}>`,
		`**Channel:** <#${giveaway.channelId}>`,
		giveaway.ended ? `**Winner(s):** ${formatWinnersLine(giveaway.winnerIds)}` : `**Winners:** ${giveaway.winnerCount}`,
		`**Entries:** ${entriesCount}`,
	];

	if (giveaway.messageId) {
		info.push(`[Jump to giveaway](${messageLink(giveaway.channelId, giveaway.messageId, giveaway.guildId)})`);
	}

	const heading = query
		? `**Search:** \`${query.replaceAll('`', '')}\` (${shown.length} ${shown.length === 1 ? 'match' : 'matches'})`
		: '**Members**';

	const slice = shown.slice(page * 20, (page + 1) * 20);
	const list = slice.length
		? slice.map((entry) => `\`${entry.position}.\` <@${entry.userId}> \`${entry.userId}\``).join('\n')
		: query
			? 'No entries match that search.'
			: 'No entries yet.';

	const embed = infoEmbed([...info, '', heading, list].join('\n')).setTitle('Giveaway Details');
	return totalPages > 1 ? embed.setFooter({ text: `Page ${page + 1} of ${totalPages}` }) : embed;
}

function buildViewComponents(page: number, totalPages: number, hasQuery: boolean, hasEntries: boolean) {
	if (!hasEntries) return [];

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId('giveawayViewPrev')
			.setEmoji('◀')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page === 0),
		new ButtonBuilder()
			.setCustomId('giveawayViewNext')
			.setEmoji('▶')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page >= totalPages - 1),
		new ButtonBuilder()
			.setCustomId('giveawayViewSearch')
			.setLabel('Search')
			.setEmoji('🔍')
			.setStyle(ButtonStyle.Primary),
	);

	if (hasQuery) {
		row.addComponents(
			new ButtonBuilder().setCustomId('giveawayViewClear').setLabel('Clear').setStyle(ButtonStyle.Secondary),
		);
	}

	return [row];
}

export class GiveawayCommand extends Command {
	public constructor(context: Command.LoaderContext, options: Command.Options) {
		super(context, { ...options, preconditions: ['devMode'] });
	}

	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder: SlashCommandBuilder) =>
			builder
				.setName('giveaway')
				.setDescription('Start, end, delete, reroll or view a giveaway.')
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
				.addSubcommand((subcommand: SlashCommandSubcommandBuilder) =>
					subcommand
						.setName('start')
						.setDescription('Start a new giveaway.')
						.addStringOption((option: SlashCommandStringOption) =>
							option.setName('prize').setDescription('The prize being given away').setRequired(true).setMaxLength(100),
						)
						.addStringOption((option: SlashCommandStringOption) =>
							option.setName('duration').setDescription('Duration of the giveaway').setRequired(true).setMaxLength(20),
						)
						.addIntegerOption((option: SlashCommandIntegerOption) =>
							option
								.setName('max_entries')
								.setDescription('Maximum number of entries allowed')
								.setMinValue(1)
								.setMaxValue(10000),
						)
						.addIntegerOption((option: SlashCommandIntegerOption) =>
							option.setName('winners').setDescription('Amount of winners to pick').setMinValue(1).setMaxValue(100),
						),
				)
				.addSubcommand((subcommand: SlashCommandSubcommandBuilder) =>
					subcommand
						.setName('end')
						.setDescription('End a giveaway early.')
						.addStringOption((option: SlashCommandStringOption) =>
							option.setName('id').setDescription('The message ID of the giveaway').setRequired(true).setMaxLength(32),
						),
				)
				.addSubcommand((subcommand: SlashCommandSubcommandBuilder) =>
					subcommand
						.setName('delete')
						.setDescription('Delete a giveaway.')
						.addStringOption((option: SlashCommandStringOption) =>
							option.setName('id').setDescription('The message ID of the giveaway').setRequired(true).setMaxLength(32),
						),
				)
				.addSubcommand((subcommand: SlashCommandSubcommandBuilder) =>
					subcommand
						.setName('reroll')
						.setDescription('Reroll the winner(s) of an ended giveaway.')
						.addStringOption((option: SlashCommandStringOption) =>
							option.setName('id').setDescription('The message ID of the giveaway').setRequired(true).setMaxLength(32),
						)
						.addIntegerOption((option: SlashCommandIntegerOption) =>
							option.setName('winners').setDescription('Amount of winners to pick').setMinValue(1).setMaxValue(100),
						),
				)
				.addSubcommand((subcommand: SlashCommandSubcommandBuilder) =>
					subcommand
						.setName('view')
						.setDescription('View a giveaway and the members in it.')
						.addStringOption((option: SlashCommandStringOption) =>
							option
								.setName('id')
								.setDescription('The giveaway to view')
								.setRequired(true)
								.setAutocomplete(true)
								.setMaxLength(100),
						),
				),
		);
	}

	public override async autocompleteRun(interaction: Command.AutocompleteInteraction) {
		if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
			await interaction.respond([]);
			return;
		}

		const giveaways = await searchGuildGiveaways(interaction.guildId, interaction.options.getFocused().trim());

		await interaction.respond(
			giveaways.map((giveaway) => ({
				name: `${truncate(giveaway.prize, 88)} (${giveaway.ended ? 'ended' : 'active'})`,
				value: giveaway.messageId!,
			})),
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		if (!interaction.inCachedGuild()) {
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} This command can only be used in a server.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const member = interaction.member as GuildMember;

		if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} You do not have permission to manage giveaways.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const subcommand = interaction.options.getSubcommand();

		if (subcommand === 'start') {
			await this.handleStart(interaction);
			return;
		}

		if (subcommand === 'end') {
			await this.handleEnd(interaction);
			return;
		}

		if (subcommand === 'delete') {
			await this.handleDelete(interaction);
			return;
		}

		if (subcommand === 'reroll') {
			await this.handleReroll(interaction);
			return;
		}

		if (subcommand === 'view') {
			await this.handleView(interaction);
			return;
		}
	}

	private async handleStart(interaction: Command.ChatInputCommandInteraction<'cached'>) {
		const prize = interaction.options.getString('prize', true);
		const durationStr = interaction.options.getString('duration', true) as StringValue;
		const maxEntries = interaction.options.getInteger('max_entries') ?? 10000;
		const winners = interaction.options.getInteger('winners') ?? undefined;

		const duration = ms(durationStr);
		if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} Invalid duration format.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (duration > MAX_DURATION) {
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} Giveaway duration cannot exceed 30 days.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (!interaction.channel?.isSendable()) {
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} I can't post a giveaway in this channel.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (await containsBlockedWord(interaction.guildId, prize)) {
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} That prize contains a word blocked by this server.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const endsAt = new Date(Date.now() + duration);

		const giveaway = await createGiveaway(
			interaction.guild.id,
			interaction.guild.name,
			interaction.channel.id,
			interaction.user.id,
			prize,
			endsAt,
			maxEntries,
			winners,
		);

		let message: Message;
		try {
			message = await interaction.channel.send({
				embeds: [buildGiveawayEmbed(giveaway)],
				components: buildGiveawayComponents(giveaway),
			});
		} catch (err) {
			logger.error(err);
			await deleteGiveaway(giveaway.id).catch((cleanupErr) => logger.error(cleanupErr));
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} Failed to post the giveaway. Please try again.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		try {
			await setGiveawayMessageId(giveaway.id, message.id);
		} catch (err) {
			logger.error(err);
			await deleteGiveaway(giveaway.id).catch((cleanupErr) => logger.error(cleanupErr));
			await message.delete().catch((cleanupErr) => logger.error(cleanupErr));
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} Failed to post the giveaway. Please try again.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await scheduleGiveawayEnd(giveaway);

		await interaction.reply({
			embeds: [successEmbed(`${emojis.rightArrow2} Giveaway started for **${prize}**!\nMessage ID: \`${message.id}\``)],
			flags: MessageFlags.Ephemeral,
		});
	}

	private async replyGiveawayNotFound(interaction: Command.ChatInputCommandInteraction<'cached'>) {
		await interaction.reply({
			embeds: [errorEmbed(`${emojis.rightArrow2} No giveaway found for that message.`)],
			flags: MessageFlags.Ephemeral,
		});
	}

	private async handleEnd(interaction: Command.ChatInputCommandInteraction<'cached'>) {
		const messageId = interaction.options.getString('id', true);
		const giveaway = await getGiveawayByMessageId(interaction.guild.id, messageId);

		if (!giveaway) {
			await this.replyGiveawayNotFound(interaction);
			return;
		}

		const result = await endGiveaway(interaction.client, giveaway.id);

		if (result.status === 'not-found') {
			await this.replyGiveawayNotFound(interaction);
			return;
		}

		if (result.status === 'already-ended') {
			await interaction.reply({
				embeds: [infoEmbed(`${emojis.rightArrow2} That giveaway has already ended.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const winnersLine = formatWinnersLine(result.giveaway.winnerIds);

		await interaction.reply({
			embeds: [
				successEmbed(`${emojis.rightArrow2} Giveaway for **${giveaway.prize}** ended.\nWinner(s): ${winnersLine}`), // todo: technically could make it swap between "winner" and "winners" based on the number of winners, but i'm too lazy to do that right now
			],
			allowedMentions: { parse: [] },
			flags: MessageFlags.Ephemeral,
		});
	}

	private async handleDelete(interaction: Command.ChatInputCommandInteraction<'cached'>) {
		const messageId = interaction.options.getString('id', true);
		const giveaway = await getGiveawayByMessageId(interaction.guild.id, messageId);

		if (!giveaway) {
			await this.replyGiveawayNotFound(interaction);
			return;
		}

		await unscheduleGiveawayEnd(giveaway.id);
		await deleteGiveaway(giveaway.id);

		const channel = await getChannel(interaction.guild.channels, giveaway.channelId);

		if (channel?.isTextBased()) {
			await channel.messages.delete(messageId).catch(() => {});
		}

		await interaction.reply({
			embeds: [successEmbed(`${emojis.rightArrow2} Giveaway for **${giveaway.prize}** has been deleted.`)],
			flags: MessageFlags.Ephemeral,
		});
	}

	private async handleView(interaction: Command.ChatInputCommandInteraction<'cached'>) {
		const messageId = interaction.options.getString('id', true).trim();
		const giveaway = await getGiveawayByMessageId(interaction.guild.id, messageId);

		if (!giveaway) {
			await this.replyGiveawayNotFound(interaction);
			return;
		}

		const allEntries: ViewEntry[] = giveaway.entries.map((userId, index) => ({ userId, position: index + 1 }));
		const hasEntries = allEntries.length > 0;
		let shown = allEntries;
		let query: string | null = null;
		let page = 0;

		const totalPages = () => Math.max(1, Math.ceil(shown.length / 20));
		const render = () => ({
			embeds: [buildViewEmbed(giveaway, shown, page, totalPages(), query)],
			components: buildViewComponents(page, totalPages(), query !== null, hasEntries),
			allowedMentions: { parse: [] },
		});

		const response = await interaction.reply({ ...render(), flags: MessageFlags.Ephemeral, withResponse: true });
		if (!hasEntries) return;

		const message = response.resource!.message!;

		while (true) {
			const btn = await awaitMessageComponentSafe(message, {
				filter: (i: MessageComponentInteraction) => i.user.id === interaction.user.id,
				time: 120_000,
			});

			if (!btn) {
				await interaction.editReply({ components: [] }).catch(() => {});
				break;
			}

			if (btn.customId === 'giveawayViewPrev') page = Math.max(0, page - 1);
			if (btn.customId === 'giveawayViewNext') page = Math.min(totalPages() - 1, page + 1);

			if (btn.customId === 'giveawayViewClear') {
				query = null;
				shown = allEntries;
				page = 0;
			}

			if (btn.customId === 'giveawayViewSearch') {
				const input = new TextInputBuilder()
					.setCustomId('value')
					.setStyle(TextInputStyle.Short)
					.setRequired(true)
					.setMaxLength(32)
					.setPlaceholder('username or id');
				if (query) input.setValue(query);

				const submitted = await promptForModalInput(
					btn,
					`giveawayViewSearch-${interaction.id}`,
					'Search Entries',
					'Username, nickname or user ID',
					input,
				);

				if (!submitted) continue;

				query = submitted.fields.getTextInputValue('value').trim() || null;
				shown = query ? await searchEntries(interaction.guild, allEntries, query) : allEntries;
				page = 0;

				await submitted.editReply(render());
				continue;
			}

			await btn.update(render());
		}
	}

	private async handleReroll(interaction: Command.ChatInputCommandInteraction<'cached'>) {
		const messageId = interaction.options.getString('id', true);
		const winners = interaction.options.getInteger('winners') ?? undefined;
		const giveaway = await getGiveawayByMessageId(interaction.guild.id, messageId);

		if (!giveaway) {
			await this.replyGiveawayNotFound(interaction);
			return;
		}

		const result = await rerollGiveaway(interaction.client, giveaway.id, winners);

		if (result.status === 'not-found') {
			await this.replyGiveawayNotFound(interaction);
			return;
		}

		if (result.status === 'not-ended') {
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} That giveaway hasn't ended yet.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (result.status === 'no-entries') {
			await interaction.reply({
				embeds: [errorEmbed(`${emojis.rightArrow2} There are no other eligible entries to reroll.`)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const winnersLine = formatWinnersLine(result.giveaway.winnerIds);

		await interaction.reply({
			embeds: [
				successEmbed(
					`${emojis.rightArrow2} Giveaway for **${giveaway.prize}** rerolled.\nNew winner(s): ${winnersLine}`,
				),
			],
			allowedMentions: { parse: [] },
			flags: MessageFlags.Ephemeral,
		});
	}
}
