const {Client, LocalAuth} = require('whatsapp-web.js');
const {locateChrome} = require('locate-app');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const messageBase = fs.readFileSync('./message.txt', 'utf8');
const vulentirs = [
	{
		name: 'NAME',
		phone: '+972 *****'
	}
]
const counter = 0;

async function start() {
	const client = new Client({
		puppeteer: {
			headless: false,
			args: ['--no-sandbox'],
			executablePath: await locateChrome()
		},
		authStrategy: new LocalAuth(
			{
				clientId: '1',
			}
		),
		authTimeoutMs: 0,
	});

	client.on('qr', (qr) => {
		console.log('QR RECEIVED', qr);
		qrcode.generate(qr, {small: true});
	});

	client.on('authenticated', () => {
		console.log('AUTHENTICATED');
	});

	client.on('ready', () => {
		console.log('READY');
	});

	client.on('message_create', async (message) => {
		console.log('message', message);
		handle_message(client, message).then();
	});

	client.on('group_membership_request', async (request) => {
		console.log('group_membership_request', request);
		const {chatId, timestamp, author} = request;
		handle_membership_request(client, chatId, timestamp, author).then();
	});

	client.on('group_join', async (request) => {
		console.log('group_join', request);
		const {chatId, timestamp, author} = request;
		handle_group_join(client, chatId, timestamp, author).then();
	});

	client.on('disconnected', (reason) => {
		console.log('Client was logged out', reason);
	});

	client.initialize().then();
}

async function handle_membership_request(client, chatId, timestamp, author) {
	const {name: current_name, phone: current_number} = await getCurrent();
	const chat = await client.getChatById(chatId);
	const date = new Date(timestamp * 1000);
	// await addToSheet(current_name, current_number, chat.name, date.toLocaleDateString(), author);

	console.log('handle_membership_request', {
		current_name,
		current_number,
		chat_name: chat.name,
		date: date.toLocaleDateString({timeZone: 'Asia/Jerusalem'}),
		author
	});

	const message = messageBase
		.replace('MANAGER_NAME', current_name)
		.replace('PHONE_NUMBER', current_number);

	await client.sendMessage(author, message);

	const current_number_id = current_number.replace(/\D/g, '') + '@c.us';
	await client.sendMessage(current_number_id, `+${author.replace(/\D/g, '')} - ${chat.id._serialized}`)
}

async function handle_group_join(client, chatId, timestamp, author) {
	// const date = new Date(timestamp * 1000);
	// await removeFromSheet(author, date.toLocaleDateString());
	console.log('handle_group_join', author);
}

async function handle_message(client, message) {
	if (vulentirs.map(raw => raw.phone.replace(/\D/g, '') + '@c.us').includes(message.from)) {
		if (message.hasQuotedMsg) {
			const quotedMessage = await message.getQuotedMessage();
			const data = quotedMessage.body.split(' - ');
			if (data.length !== 2) {
				message.reply('הודעה שעליה הגבת לא תקינה');
			}

			const [author, chatId] = data;
			const author_id = author.replace(/\D/g, '') + '@c.us';
			if (message.body === 'כן') {
				await client.approveGroupMembershipRequests(chatId, { requesterIds: [author_id] })
			} else if (message.body === 'לא') {
				await client.rejectGroupMembershipRequests(chatId, { requesterIds: [author_id] })
			}
			else {
				message.reply('לא הבנתי את התשובה, נסה שוב [כן/לא]');
			}
		}
		else {
			message.reply('עליך להגיב על הודעה');
		}
	}
}

async function getCurrent() {
	const id = counter % vulentirs.length;
	return vulentirs[id];
}

start().then();
