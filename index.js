const {Client, LocalAuth, Poll} = require('whatsapp-web.js');
const {locateChrome} = require('locate-app');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const {addToWaitingList, addUser, getAllVolunteers} = require('./sheets-manegment');

const messageBase = fs.readFileSync('./files/message.txt', 'utf8');
const groupsIds = JSON.parse(fs.readFileSync('./files/groupsIds.json', 'utf8')).groupIds;
let counter = 0;
let volunteers;
getAllVolunteers().then((newVolunteers) => {
	volunteers = newVolunteers;
});

const PollOptions = {
	'APPROVE': 'אשר',
	'DENY': 'דחה',
	'NOT_ANSWERED': 'לא ענה',
}


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

	// client.on('message_create', async (message) => {
	// 	handle_message(client, message).then();
	// });

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


	client.on('vote_received', async (vote) => {
		handle_poll_vote(client, vote).then();
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
	const text = `רוצים להצטרף לקבוצה *${chat.name}*
לחצו על מספר הטלפון לכניסה לצאט +${author.replace(/\D/g, '')}

➖➖➖➖➖➖➖➖➖➖➖
${chatId} - ${author}
`
	const poll = new Poll(text, [PollOptions.APPROVE, PollOptions.DENY, PollOptions.NOT_ANSWERED], {allowMultipleAnswers: false});
	await client.sendMessage(current_number_id, poll);
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

async function handle_poll_vote(client, vote) {
	const {selectedOption, parentMessage, senderTimestampMs, voter} = vote;
	const splitBody = parentMessage.body.split('➖➖➖➖➖➖➖➖➖➖➖');
	if (splitBody.length !== 2) {
		return;
	}

	const volunteer = volunteers.find(volunteer => volunteer.phone === voter.replace(/\D/g, ''));

	const date = new Date(senderTimestampMs * 1000);
	const [chatId, userId] = splitBody[1].trim().split(' - ');

	const chat = await client.getChatById(chatId);
	if (selectedOption.name === PollOptions.APPROVE) {
		await client.approveGroupMembershipRequests(chatId, { requesterIds: [userId] })
	}
	if (selectedOption.name === PollOptions.DENY) {
		await client.rejectGroupMembershipRequests(chatId, { requesterIds: [userId] })
		await addUser({
			phoneNumber: userId.replace(/\D/g, ''),
			date,
			action: 'נדחה',
			chatName: chat.name,
			associatedVolunteer: volunteer
		});

	}
}

async function getVolunteer(client) {
	while (true) {
		let index = counter % volunteers.length;
		counter++;

		const volunteer =  volunteers[index];
		const chat = await client.getChatById(volunteer.phone + '@c.us');
		const lastMessages = await chat.fetchMessages({limit: 1});
		if (lastMessages.length === 0) {
			return volunteer;
		}
		else {
			const lastMessage = lastMessages[0];
			if (lastMessage.fromMe && lastMessage.type === 'poll_creation') {
				if (lastMessage) {
					return volunteer;
				} // TODO: check if poll get answers
			}
			return volunteer;
		}

	}
}

start().then();
