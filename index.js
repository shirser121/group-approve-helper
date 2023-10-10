const {Client, LocalAuth, Poll} = require('whatsapp-web.js');
const {locateChrome} = require('locate-app');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const {addToWaitingList, addUser, getAllVolunteers, getAllWaitingList} = require('./sheets-manegment');

const groupsIds = JSON.parse(fs.readFileSync('./files/groupsIds.json', 'utf8')).groupIds;
let volunteersReminderMessage = fs.readFileSync('./files/volunteersReminderMessage.txt', 'utf8');
let volunteersAlertMessage = fs.readFileSync('./files/volunteersAlertMessage.txt', 'utf8');
let volunteerNewRequestMessage = fs.readFileSync('./files/informMessageNewRequest.txt', 'utf8');

let counter = 0;
let volunteers;

const PollOptions = {
	'APPROVE': 'אשר',
	'DENY': 'דחה',
	'NOT_ANSWERED': 'לא ענה',
}


async function start() {
	const client = new Client({
		puppeteer: {
			headless: false,
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
			],
			defaultViewport: null,
			font: 'Arial, "Noto Sans Hebrew", "Noto Sans", sans-serif',
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

	client.on('dialog', async dialog => {
		console.log("Refresh popup just dismissed")
		await dialog.dismiss()
	});

	client.on('error', (event) => {
		client.destroy().then(() => client.initialize());
		console.log('Page error... Client is ready again!');
	});


	client.on('ready', () => {
		console.log('READY');
		handle_ready(client).then();
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
			handle_group_join(client, chatId, timestamp, recipient).then();
		}
	});

	client.on('disconnected', (reason) => {
		console.log('Client Disconnected', reason);
		client.initialize();
	});


	client.on('vote_received', async (vote) => {
		handle_poll_vote(client, vote).then();
	});

	client.initialize().then();
}

async function handle_ready(client) {
	for (const chatId of groupsIds) {
		const chat = await client.getChatById(chatId);
		const pendingRequests = await chat.getGroupMembershipRequests();
		const [allPendingFromSheet, ] = await getAllPendingFromSheet(chat.name);
		const filteredPending = pendingRequests.filter((request) => {
			return !allPendingFromSheet.includes(request.id.user);
		});

		for (const request of filteredPending) {
			await handle_membership_request(client, chatId, request.t, request.id._serialized);
		}
	}
}

async function handle_membership_request(client, chatId, timestamp, author) {
	const chat = await client.getChatById(chatId);
	const date = new Date(timestamp * 1000);

	const [allPendingFromSheet, fullData] = await getAllPendingFromSheet(chat.name);
	if (allPendingFromSheet.includes(author)) {
		const rawData = fullData.find((data) => data.phone === author);
		const date = new Date();
		if (rawData) {
			// If date before 35 minutes ago
			if (rawData.date < (date - 35 * 60 * 1000)) {
				await addUser({
					date: new Date(),
					chatName: chat.name,
					phoneNumber: author.replace(/\D/g, ''),
					associatedVolunteer: {
						name: rawData.volunteerName,
						phone: rawData.volunteerNumber
					},
					action: 'רענון בקשה'
				});
			}
			else if (rawData.date < date - 30 * 60 * 1000) {
				return;
			}
		}
	}

	let volunteer
	while (!volunteer) {
		volunteer = await getVolunteer(client);
		if (!volunteer) {
			await new Promise(resolve => setTimeout(resolve, 20 * 1000));
		}
	}
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

	const message = fs.readFileSync('./files/message.txt', 'utf8')
		.replace('MANAGER_NAME', volunteer.name)
		.replace('PHONE_NUMBER', volunteer.phone);

	await client.sendMessage(author, message);

	const current_number_id = volunteer.phone.replace(/\D/g, '') + '@c.us';

	const messageForNewRequest = volunteerNewRequestMessage
		.replace('PHONE_NUMBER', author.replace(/\D/g, ''))
		.replace('CHAT_NAME', chat.name)
		.replace('chatId', chatId)
		.replace('author', author);

	const poll = new Poll(messageForNewRequest, [PollOptions.APPROVE, PollOptions.DENY, PollOptions.NOT_ANSWERED], {allowMultipleAnswers: false});
	await client.sendMessage(current_number_id, poll);
}

async function handle_group_join(client, chatId, timestamp, recipient) {
	const date = new Date(timestamp * 1000);
	const chat = await client.getChatById(chatId);
	// await removeFromSheet(recipient, date.toLocaleDateString());
	await addUser({
		phoneNumber: recipient.replace(/\D/g, ''),
		date,
		action: 'הצטרף',
		chatName: chat.name,
	});
	console.log('handle_group_join', recipient);
}

async function handle_poll_vote(client, vote) {
	const {selectedOption, parentMessage, senderTimestampMs, voter} = vote;

	const [chatId, userId] = getDataFromPoll(parentMessage)
	if (!userId) {
		return;
	}

	const volunteer = volunteers.find(volunteer => volunteer.phone === voter.replace(/\D/g, ''));
	const date = new Date(senderTimestampMs * 1000);

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
	volunteers = await getAllVolunteers();
	let index = counter % volunteers.length;
	counter++;

	const volunteer =  volunteers[index];
	const chat = await client.getChatById(volunteer.phone + '@c.us');
	const lastMessages = await chat.fetchMessages({limit: 5});
	if (lastMessages.length === 0) {
		return volunteer;
	}
	else {
		lastMessages.reverse();
		const lastPoll = lastMessages.find(message => message.type === 'poll_creation');
		const lastMessage = lastMessages[0];
		const [chatId, userId] = getDataFromPoll(lastPoll);

		if (userId) {
			const group = await client.getChatById(chatId);
			const groupParticipants = group.participants.map(participant => participant.id._serialized);

			if (await isPollAnswered(client, lastPoll.id._serialized) || !lastMessage.fromMe) {
				return volunteer;
			}
			else if (lastPoll.timestamp * 1000 < Date.now() - 1000 * 60 * 35 /* 35 minutes */) {
				if (lastMessage.body !== volunteersAlertMessage) {
					await client.sendMessage(volunteer.phone + '@c.us', volunteersReminderMessage)
				}
				if (!groupParticipants.includes(userId)) {
					handle_membership_request(client, chatId, lastPoll.timestamp, userId).then();
				}
			}
			else if (lastMessage.timestamp * 1000 < Date.now() - 1000 * 60 * 10 /* 10 minutes */) {
				await client.sendMessage(volunteer.phone + '@c.us', volunteersReminderMessage);
			}
		} else {
			return volunteer;
		}
	}
}

async function getAllPendingFromSheet(groupName) {
	const data = await getAllWaitingList();
	return [data.filter(row => row.groupName === groupName).map(row => row.phone), data];
}

async function isPollAnswered(client, msgId) {
	return await client.pupPage.evaluate(async (msgId) => {
		const getVotes = window.mR.findModule('getVotes')[0].getVotes;
		const votes = await getVotes([msgId]);
		if (!votes || votes.length === 0) {
			return false;
		}
		return true;
	}, msgId);
}

function getDataFromPoll(pollMessage) {
	if (!pollMessage) {
		return [];
	}
	const splitBody = pollMessage.body.split('➖➖➖➖➖➖➖➖➖➖➖');
	if (splitBody.length !== 2) {
		return [];
	}
	return splitBody[1].trim().split(' - ');
}

process.on('unhandledRejection', (reason, p) => {
	console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

start().then();
