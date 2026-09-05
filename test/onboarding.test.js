const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOnboardingEvent, captureMemberOnboarding, onboardingChanged, resetOnboardingForTests } = require('../src/bot/onboarding');
const { onboardingRecordText } = require('../src/backend/telegram-archive');

function collection(values) { return { values: () => values.values(), keys: () => values.keys() }; }
function member(overrides = {}) {
  const everyone = { id: 'guild-1', name: '@everyone' };
  const assigned = [{ id: 'role-1', name: 'Builders' }, { id: 'role-2', name: 'Mentors' }];
  const options = new Map([['option-a', { id: 'option-a', title: 'Bots', description: 'Discord bots' }], ['option-b', { id: 'option-b', title: 'Web apps', description: 'Web applications' }]]);
  const prompts = new Map([['prompt-1', { id: 'prompt-1', title: 'What are you building?', type: 1, required: true, inOnboarding: true, options: collection(options) }]]);
  const guild = { id: 'guild-1', name: "Developer's Forge", roles: { everyone }, onboarding: { prompts: collection(prompts) } };
  const user = { id: 'user-1', username: 'member', globalName: 'Forge Member', avatar: 'user-avatar', createdAt: new Date('2024-01-01T00:00:00Z'), displayName: 'Forge Member', displayAvatarURL: () => 'https://cdn.example/user-avatar' };
  return { id: user.id, user, guild, displayName: 'Forge Member', avatar: 'member-avatar', joinedAt: new Date('2026-08-30T00:00:00Z'), pending: false, flags: { bitfield: 4 }, roles: { cache: collection(new Map(assigned.map(role => [role.id, role]))) }, ...overrides };
}

test('onboarding event captures available identity, guild, join, avatar, and role data', async () => {
  const event = await buildOnboardingEvent(member(), 'MEMBER_ONBOARDING', new Date('2026-08-31T00:00:00Z'));
  assert.equal(event.type, 'MEMBER_ONBOARDING'); assert.equal(event.discordUserId, 'user-1'); assert.equal(event.accountCreatedAt, '2024-01-01T00:00:00.000Z'); assert.equal(event.joinedAt, '2026-08-30T00:00:00.000Z'); assert.equal(event.guildName, "Developer's Forge");
  assert.deepEqual(event.roles, [{ role_id: 'guild-1', role_name: '@everyone', is_everyone: true }, { role_id: 'role-1', role_name: 'Builders', is_everyone: false }, { role_id: 'role-2', role_name: 'Mentors', is_everyone: false }]); assert.equal(event.avatar.member_hash, 'member-avatar');
});

test('onboarding event preserves every configured prompt and option but does not invent selected answers', async () => {
  const event = await buildOnboardingEvent(member()); const prompt = event.onboarding.prompts.prompts[0];
  assert.equal(event.onboarding.prompts.status, 'available_configuration_only'); assert.equal(prompt.question_id, 'prompt-1'); assert.deepEqual(prompt.options.map(option => option.option_id), ['option-a', 'option-b']); assert.equal(event.onboarding.selectedAnswers.status, 'unavailable_through_discord_bot_api'); assert.deepEqual(event.onboarding.selectedAnswers.answers, []); assert.equal(event.onboarding.completed, null);
});

test('membership screening pending is captured without mislabeling it as onboarding completion', async () => { const event = await buildOnboardingEvent(member({ pending: true })); assert.equal(event.onboarding.membershipScreeningPending, true); assert.equal(event.onboarding.completed, null); assert.equal(event.onboarding.completionStatus, 'unavailable_through_discord_bot_api'); });

test('onboarding updates are detected from available member changes', () => { assert.equal(onboardingChanged(member({ pending: true }), member({ pending: false })), true); assert.equal(onboardingChanged(member(), member()), false); });

test('onboarding capture is idempotent for the same member data and event type during runtime', async () => { resetOnboardingForTests(); const calls = []; const options = { postArchive: async event => calls.push(event), env: {}, logger: { log() {} } }; const first = await captureMemberOnboarding(member(), options); const second = await captureMemberOnboarding(member(), options); assert.equal(first.archived, true); assert.equal(second.skipped, 'duplicate_event'); assert.equal(calls.length, 1); });

test('onboarding archive format is readable and renders the current member avatar URL without AI fields', async () => { const event = await buildOnboardingEvent(member()); const text = onboardingRecordText(event); assert.match(text, /Community Profile Record/); assert.match(text, /Discord ID: user-1/); assert.match(text, /Profile picture: https:\/\/cdn\.example\/user-avatar/); assert.match(text, /Source: discord_onboarding/); assert.match(text, /Roles:/); assert.doesNotMatch(text, /question=|response=|provider=|CONVERSATION_RECORD/); });

test('onboarding JOIN card prefers the current member avatar URL when available', async () => { const event = await buildOnboardingEvent(member({ avatarURL: () => 'https://cdn.example/member-avatar' })); const text = onboardingRecordText(event); assert.match(text, /Profile picture: https:\/\/cdn\.example\/member-avatar/); });

test('Discord client requests the Guild Members intent for onboarding lifecycle events', () => {
  const bot = require('../src/bot');
  const { GatewayIntentBits } = require('discord.js');
  const client = bot.createBot();
  assert.equal(client.options.intents.has(GatewayIntentBits.GuildMembers), true);
  client.destroy();
});
