import { TextChannel, VoiceChannel, GuildMember, Collection } from 'discord.js';
import {
  CARDS_ON_TABLE,
  FAKE_USER_TIME,
  MAXIMUM_PLAYERS,
  MAX_ROLES_COUNT,
  MINIMUM_PLAYERS,
  NIGHT_ALMOST_OVER_REMINDER,
  ROUND_TIME_MILLISECONDS,
  ROUND_TIME_MINUTES,
} from './Constants';
import { RoleName } from './enums/RoleName';
import { getGamesManagerInstance } from './GamesManager';
import { Log } from './Log';
import { Player } from './Player';
import { GameState } from './GameState';
import { isMimicRole, Role } from './roles/Role';
import { AcknowledgeMessage, ChoosePlayer } from './ConversationHelper';
import { Time } from './types/Time';
import { ChoosePlayerType } from './enums/ChoosePlayer';
import { getSoundManagerInstance } from './SoundManager';

export class Game {
  public readonly players: Player[];
  private readonly _textChannel: TextChannel;
  private readonly _chosenRoles: RoleName[];
  private _startGameState: GameState;
  public readonly gameState: GameState;
  private _started: boolean;
  private _startTime: Date | null;
  public newDoppelgangerRole: RoleName | null;
  private _hasVoice: boolean;

  constructor(
    players: GuildMember[],
    textChannel: TextChannel,
    voiceChannel: VoiceChannel,
    chosenRoles: RoleName[]
  ) {
    if (players.length < MINIMUM_PLAYERS || players.length > MAXIMUM_PLAYERS) {
      throw new Error('Invalid amount of players');
    }
    this.players = players.map((player) => new Player(player));
    this._textChannel = textChannel;
    this._chosenRoles = chosenRoles;
    this._startGameState = new GameState();
    this.gameState = new GameState();
    this._started = false;
    this._startTime = null;
    this.newDoppelgangerRole = null;

    try {
      getSoundManagerInstance().voiceChannel = voiceChannel;
      this._hasVoice = true;
    } catch (error) {
      this._hasVoice = false;
    }
  }

  public get remainingTime(): Time {
    if (!this._startTime) {
      throw new Error('Countdown has not started yet.');
    }
    const now = new Date().getTime();
    const finish = this._startTime.getTime() + ROUND_TIME_MILLISECONDS;
    return millisToTime(finish - now);
  }

  public get textChannel(): TextChannel {
    return this._textChannel;
  }

  public get tagPlayersText(): string {
    return this.players.map(({ tag }) => tag).join(', ');
  }

  public moveDoppelGanger(name: RoleName): void {
    const doppelgangerPlayer = (
      this.gameState.playerRoles.doppelganger?.slice() as Player[]
    )[0];
    this.gameState.playerRoles[name]?.push(doppelgangerPlayer);
    this.gameState.playerRoles.doppelganger = [];
    this.newDoppelgangerRole = name;
  }

  public async start(): Promise<void> {
    if (this._started) {
      throw new Error('Game has already started');
    }

    this._textChannel.send(
      `Starting new game with players: ${this.tagPlayersText}
And with these roles: ${this._chosenRoles.join(', ')}`
    );
    this._started = true;

    const chosenRoles = shuffle(
      this._chosenRoles.map((roleName) =>
        this.gameState.getRoleByName(roleName)
      )
    ) as Role[];

    const callOrder = [
      RoleName.doppelganger,
      RoleName.werewolf,
      RoleName.minion,
      RoleName.mason,
      RoleName.seer,
      RoleName.robber,
      RoleName.troublemaker,
      RoleName.drunk,
      RoleName.insomniac,
    ];

    for (let index = 0; index < chosenRoles.length; index++) {
      const role = chosenRoles[index];
      if (index >= chosenRoles.length - CARDS_ON_TABLE) {
        this.gameState.tableRoles.push(role);
      } else {
        const player = this.players[index];
        // if (callOrder.includes(role.name)) {
        this.gameState.playerRoles[role.name]?.push(player);
        // }
      }
    }
    for (const roleName of Object.values(RoleName)) {
      const roles = this.gameState.playerRoles[roleName];
      if (roles) {
        const tableRolesLength = this.gameState.tableRoles.filter(
          (role) => role.name === roleName
        ).length;
        const roleCount = roles.length + tableRolesLength;
        if (roleCount > MAX_ROLES_COUNT[roleName]) {
          throw new Error(
            `Invalid role distribution, There are ${roleCount} with role ${roleName} when there is a maximum of ${MAX_ROLES_COUNT[roleName]}`
          );
        }
      }
    }

    this._startGameState = this.gameState.copy();

    if (this._hasVoice) {
      getSoundManagerInstance().startNightLoop();
    }

    const roleMessages = this.players.map((player) => {
      const roleName = this.gameState.getRoleName(player);
      const text = `Welcome to a new game of One Night Ultimate Discord!
=========================================
A new game has started where you have the role **${roleName}**.
You fall deeply asleep.`;
      return AcknowledgeMessage(player, text);
    });

    const invalidPlayerIDs = (await Promise.allSettled(roleMessages))
      .map((item, i) => ({ ...item, i }))
      .filter((result) => result.status === 'rejected')
      .map(({ i }) => {
        return this.players[i].id;
      });

    if (invalidPlayerIDs.length !== 0) {
      Log.warn(
        'Unable to start game due to privacy settings for some player(s)'
      );
      const playerNames = invalidPlayerIDs.reduce(
        (acc, id) => `${acc}- <@${id}>\n`,
        ''
      );
      this._textChannel.send(
        `Unable to start game because I cannot send a DM to the following player(s):
${playerNames}
Please check your privacy settings.`
      );
      this.stopGame();
      return;
    }
    // start game
    try {
      for (const roleName of callOrder) {
        const players = this._startGameState.playerRoles[roleName];
        if (players && players?.length > 0) {
          const role = this.gameState.getRoleByName(roleName);
          let roles = players.map((player) => role.doTurn(this, player));
          if (
            this.newDoppelgangerRole === roleName &&
            isMimicRole(roleName) &&
            this._startGameState.playerRoles.doppelganger &&
            this._startGameState.playerRoles.doppelganger?.length > 0
          ) {
            const doppelGangers =
              this._startGameState.playerRoles.doppelganger.map((dplgnr) =>
                role.doTurn(this, dplgnr)
              );
            roles = roles.concat(doppelGangers);
          }
          await Promise.all(roles);
        } else if (this._chosenRoles.includes(roleName)) {
          Log.info(`Faking ${roleName} because it's a table role`);
          await new Promise((resolve) => setTimeout(resolve, FAKE_USER_TIME));
        }
      }
    } catch (error) {
      Log.error(error);
      this._textChannel.send(error.message);
      this.stopGame();
      return;
    }
    Log.info('Night over');

    if (this._hasVoice) {
      getSoundManagerInstance().stopNightLoop();
    }

    this._startTime = new Date();

    await this._textChannel.send(
      `${this.tagPlayersText}: The night is over! You now have ${ROUND_TIME_MINUTES} minutes to figure out what has happened!`
    );
    const wakeUpOrder = callOrder
      .filter((roleName) => this._chosenRoles.includes(roleName))
      .map((roleName, i) => `${i + 1}: ${roleName}`)
      .join('\n');
    await this._textChannel.send(`Wakeup order:\n${wakeUpOrder}`);
    await new Promise((resolve) =>
      setTimeout(resolve, ROUND_TIME_MILLISECONDS - NIGHT_ALMOST_OVER_REMINDER)
    );
    await this._textChannel.send(
      `${this.tagPlayersText} ${
        NIGHT_ALMOST_OVER_REMINDER / 1000
      } seconds remaining!`
    );
    setTimeout(() => this.endGame(), NIGHT_ALMOST_OVER_REMINDER);
  }

  private async endGame() {
    await this._textChannel.send(
      `Everybody stop talking! That means you ${this.tagPlayersText}
Reply to the DM you just received to vote for who to kill.`
    );

    const choosePromises = this.players.map((player) =>
      ChoosePlayer(
        this.players,
        player,
        ChoosePlayerType.kill,
        'Choose a player to kill'
      )
    );
    const chosenPlayers = (await Promise.all(choosePromises)).flat();

    const votedForPlayers: Collection<
      string,
      { count: number; player: Player }
    > = new Collection();
    for (const player of chosenPlayers) {
      const oldPlayer = votedForPlayers.get(player.id);
      let count = 1;
      if (oldPlayer) {
        count = oldPlayer.count + 1;
      }
      votedForPlayers.set(player.id, { count, player });
    }

    const highestVoteCount = votedForPlayers.reduce(
      (acc, { count }) => Math.max(acc, count),
      1
    );

    const votingOverview = votedForPlayers
      .map(({ player, count }) => `${player.name}: ${count}`)
      .join('\n');

    this.textChannel.send(`Voting overview:\n${votingOverview}`);

    let winner = '';
    // If no player receives more than one vote, no one dies.
    if (highestVoteCount === 1) {
      this.textChannel.send('Nobody dies!');
      // If a werewolf is among the players, team werewolf wins
      if (this.gameState.playerRoles.werewolf) {
        winner = 'werewolf';
      }
    } else {
      const playersWhoDieWithCount = votedForPlayers.filter(
        ({ count }) => count === highestVoteCount
      );
      const playersWhoDie = playersWhoDieWithCount.map(({ player }) => player);

      let hunterIds: string[];
      if (this.gameState.playerRoles.hunter) {
        hunterIds = this.gameState.playerRoles.hunter.map(({ id }) => id);
      }
      const dyingHunters: Player[] = playersWhoDie.filter(({ id }) =>
        hunterIds.includes(id)
      );

      let tannerIds: string[];
      if (this.gameState.playerRoles.tanner) {
        tannerIds = this.gameState.playerRoles.tanner.map(({ id }) => id);
      }

      let werewolfIds: string[];
      if (this.gameState.playerRoles.werewolf) {
        werewolfIds = this.gameState.playerRoles.werewolf.map(({ id }) => id);
      }

      // Tanner wins if he receives the most votes
      if (playersWhoDie.find(({ id }) => tannerIds.includes(id))) {
        winner = 'tanner';
      } else if (playersWhoDie.find(({ id }) => werewolfIds.includes(id))) {
        winner = 'villagers';
      } else {
        winner = 'werewolf';
      }
      const playersWhoDieNames = playersWhoDieWithCount
        .map(({ player }) => player.name)
        .join(', ');
      this.textChannel.send(
        `The following player(s) die:\n${playersWhoDieNames}`
      );
      // TODO fix hunter
      // If a hunter dies, its target also dies
      if (dyingHunters.length > 0) {
        const hunterKillList = dyingHunters.map((dyingHunter) => {
          const id = chosenPlayers.findIndex(({ id }) => id === dyingHunter.id);
          return chosenPlayers[id];
        });
        if (dyingHunters.length === 1) {
          await this.textChannel.send(
            `Since ${dyingHunters[0].name} was a hunter, ${hunterKillList[0].name} also dies.`
          );
        } else {
          const hunterKillListNames = hunterKillList
            .map(({ name }) => name)
            .join(' and ');
          const dyingHuntersNames = dyingHunters
            .map(({ name }) => name)
            .join(' and ');
          await this.textChannel.send(
            `Since ${dyingHuntersNames} were hunters, ${hunterKillListNames} also die.`
          );
          // TODO check if dying players are werewolves
          const dyingHunterRoles = dyingHunters.map((p) =>
            this.gameState.getRoleName(p)
          );
          if (dyingHunterRoles.includes(RoleName.werewolf)) {
            winner = 'villagers';
          }
        }
      }
    }
    const winText = `This means **team ${winner}** has won!`;
    const winMessage = await this._textChannel.send(winText);
    await winMessage.react('🥳');

    const stateText = `Results\n**Roles before the night**:
${this._startGameState.toString()}

**Roles after the night**:
${this.gameState.toString()}`;
    await this._textChannel.send(stateText);
    Log.info('Game has ended');
    this.stopGame();
  }

  private stopGame() {
    getGamesManagerInstance().stopGame(this._textChannel);
  }
}

// Source: https://stackoverflow.com/a/2450976/2174255
function shuffle(array: unknown[]) {
  const copy = [];
  let n = array.length;
  let i;

  // While there remain elements to shuffle…
  while (n) {
    // Pick a remaining element…
    i = Math.floor(Math.random() * array.length);

    // If not already shuffled, move it to the new array.
    if (i in array) {
      copy.push(array[i]);
      delete array[i];
      n--;
    }
  }

  return copy;
}

function millisToTime(millis: number): Time {
  const minutes = Math.max(0, Math.floor(millis / 60000));
  const seconds = Math.max(Math.ceil((millis % 60000) / 1000));
  return { minutes, seconds };
}
