import { Message, TextChannel } from 'discord.js';
import { CARDS_ON_TABLE, MAX_ROLES_COUNT } from '../Constants';
import { ChooseRoles } from '../ConversationHelper';
import { getDiscordInstance } from '../DiscordClient';
import { RoleName } from '../enums/RoleName';
import { getGamesManagerInstance } from '../GamesManager';
import { Log } from '../Log';
import { Command } from '../types/Command';

const command: Command = {
  names: ['start'],
  description:
    "Start a new game. Supply the _'quick'_ option to reuse previous settings.",
  params: [
    {
      optional: true,
      name: 'quick',
    },
    {
      optional: true,
      name: 'voice channel name',
    },
  ],
  execute,
  adminOnly: false,
};

async function execute(msg: Message, args: string[]): Promise<void> {
  const client = getDiscordInstance();
  if (!client) {
    throw new Error('Discord did not initialize');
  }
  const textChannel = msg.channel as TextChannel;
  const gamesManager = getGamesManagerInstance();

  let voiceChannel;
  let quickStart = false;
  if (args.length === 0 || args[0] === 'quick') {
    if (args[0] === 'quick') {
      quickStart = true;
    }
    voiceChannel = msg.member?.voice.channel;
    if (!voiceChannel) {
      textChannel.send(
        'Please supply a voice channel ID with players, or join a voice channel.'
      );
      return;
    }
  } else {
    voiceChannel = msg.guild?.channels.cache.find(
      ({ type, name }) =>
        type === 'voice' && name.toLowerCase().includes(args[0].toLowerCase())
    );
  }
  // TODO don't forget to change this
  ///////////////////////////
  const members = voiceChannel?.members;
  // const players = await client.getDummyPlayers();
  //////////////////////////

  if (!members) {
    textChannel.send(`Empty voice channel`);
    return;
  }
  const players = members.map((m) => m.user);

  const author = msg.author;
  const amountToPick =
    players.length - MAX_ROLES_COUNT[RoleName.werewolf] + CARDS_ON_TABLE;
  const werewolves = Array.from(
    { length: MAX_ROLES_COUNT[RoleName.werewolf] },
    () => RoleName.werewolf
  );

  try {
    if (quickStart) {
      await gamesManager.quickStartGame(players, msg.channel as TextChannel);
    } else {
      const roles = [
        ...werewolves,
        ...(await ChooseRoles(author, textChannel, amountToPick)),
      ];
      await gamesManager.startNewGame(
        players,
        msg.channel as TextChannel,
        roles
      );
    }
  } catch (error) {
    Log.error(error.message);
    await textChannel.send(error.message);
  }
}
export = command;
