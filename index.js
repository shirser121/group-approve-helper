const {Client, LocalAuth} = require('whatsapp-web.js');
const {locateChrome} = require('locate-app');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const {addToWaitingList, addUser, getAllVolunteers} = require('./sheets-manegment');

const messageBase = fs.readFileSync('./files/message.txt', 'utf8');
const groupsIds = JSON.parse(fs.readFileSync('./files/groupsIds.json', 'utf8')).groupIds;
const counter = 0;
let volunteers;
getAllVolunteers().then((newVolunteers) => {
	volunteers = newVolunteers;
});

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
		handle_message(client, message).then();
	});

	client.on('group_membership_request', async (request) => {
		if (!groupsIds.includes(request.chatId)) {
			return;
		}
		console.log('group_membership_request', request);
		const {chatId, timestamp, author} = request;
		handle_membership_request(client, chatId, timestamp, author).then();
	});

	client.on('group_join', async (request) => {
		if (!groupsIds.includes(request.chatId)) {
			return;
		}

		console.log('group_join', request);
		const {chatId, timestamp, recipientIds} = request;
		for (const recipient of recipientIds) {
			handle_group_join(client, chatId, timestamp, recipient, getVolunteer()).then();
		}
	});

	client.on('disconnected', (reason) => {
		console.log('Client was logged out', reason);
	});

	client.initialize().then();
}

async function handle_membership_request(client, chatId, timestamp, author) {
	const volunteer = await getVolunteer();
	const chat = await client.getChatById(chatId);
	const date = new Date(timestamp * 1000);
	// await addToSheet(volunteerName, volunteerNumber, chat.name, date.toLocaleDateString(), author);
	await addToWaitingList({
		chatName: chat.name,
		date,
		phoneNumber: author.replace(/\D/g, ''),
		associatedVolunteer: volunteer
	});

	console.log('handle_membership_request', {
		volunteerName: volunteer.name,
		volunteerNumber: volunteer.phone,
		chatName: chat.name,
		date: date,
		phoneNumber: author.replace(/\D/g, '')
	});

	const message = messageBase
		.replace('MANAGER_NAME', volunteer.name)
		.replace('PHONE_NUMBER', volunteer.phone);

	await client.sendMessage(author, message);

	const current_number_id = volunteer.phone.replace(/\D/g, '') + '@c.us';
	await client.sendMessage(current_number_id, `+${author.replace(/\D/g, '')} - ${chat.id._serialized}`)
}

async function handle_group_join(client, chatId, timestamp, recipient, associatedVolunteer) {
	const date = new Date(timestamp * 1000);
	const chat = await client.getChatById(chatId);
	// await removeFromSheet(recipient, date.toLocaleDateString());
	await addUser({
		phoneNumber: recipient.replace(/\D/g, ''),
		date,
		action: 'הצטרף',
		chatName: chat.name,
		associatedVolunteer
	});
	console.log('handle_group_join', recipient);
}

async function handle_message(client, message) {
	if (volunteers.map(raw => raw.phone.replace(/\D/g, '') + '@c.us').includes(message.from)) {
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

async function getVolunteer() {
	const id = counter % volunteers.length;
	return volunteers[id];
}

start().then();
