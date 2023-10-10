const {Client, LocalAuth, Poll} = require('whatsapp-web.js');
const {locateChrome} = require('locate-app');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const {addToWaitingList, addUser, getAllVolunteers, getAllWaitingList} = require('./sheets-manegment');

const groupsIds = JSON.parse(fs.readFileSync('./files/groupsIds.json', 'utf8')).groupIds;
let volunteersReminderMessage = fs.readFileSync('./files/volunteersReminderMessage.txt', 'utf8');
let volunteersAlertMessage = fs.readFileSync('./files/volunteersAlertMessage.txt', 'utf8');
let volunteerNewRequestMessage = fs.readFileSync('./files/informMessageNewRequest.txt', 'utf8');
const notRespondMessage = fs.readFileSync('./files/notRespondMessage.txt', 'utf8');
const approveMessage = fs.readFileSync('./files/approveMessage.txt', 'utf8');


let counter = 0;
let volunteers;

const PollOptions = {
	'APPROVE': 'אשר',
	'DENY': 'דחה',
	'NOT_ANSWERED': 'לא ענה',
}


async function start() {
	let browserPath;
	try {
		browserPath = await locateChrome();
	} catch (err) {}
	const client = new Client({
		puppeteer: {
			headless: false,
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
			],
			defaultViewport: null,
			font: 'Arial, "Noto Sans Hebrew", "Noto Sans", sans-serif',
			executablePath: browserPath
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
	setTimeout(() => {
		handle_ready(client).then();
		console.log('run after 10 minutes')
	}, 1000 * 60 * 10);
	for (const chatId of groupsIds) {
		const chat = await client.getChatById(chatId);
		let [allPendingFromSheet, fullData] = await getAllPendingFromSheet(chat.name);

		const pendingRequests = await chat.getGroupMembershipRequests();
		console.log('pendingRequests', pendingRequests);

		const fixPendingFromSheet = fullData.filter(({phone}) => {
			let action;
			if (chat.participants.find(p => p.id.user === phone)) {
				 action = 'הצטרפות';
			}
			else if(!pendingRequests.find((request) => request.id.user === phone)) {
				action = 'הסרת בקשה';
			}
			if (action) {
				handle_group_join(client, chatId, new Date(), phone, action).then();
				return false;
			}
			return true;
	});

		for (const request of pendingRequests) {
			await handle_membership_request(client, chatId, new Date(), request.id._serialized);
		}
	}
}

async function handle_membership_request(client, chatId, timestamp, requestedUserId) {
	const chat = await client.getChatById(chatId);
	const date = new Date(timestamp * 1000);
	const requestedUserPhone = requestedUserId.replace(/\D/g, '');


	volunteers = await getAllVolunteers();

	const [allPendingFromSheet, fullData] = await getAllPendingFromSheet(chat.name);
	if (allPendingFromSheet.includes(requestedUserPhone)) {
		const rawData = fullData.find((data) => data.phone === requestedUserPhone);
		const date = new Date();
		if (rawData) {
			let action;
			if (rawData.date < (date - 15 * 60 * 1000)) {
				action = 'רענון בקשה';
				await client.sendMessage(rawData.volunteerPhone + '@c.us', volunteersAlertMessage);
			}
			else if (!volunteers.find((volunteer) => volunteer.phone === rawData.volunteerPhone)) {
				action = 'רענון בקשה עקב החלפת משמרת';
			}

			if (action) {
				await addUser({
					date: new Date(),
					chatName: chat.name,
					phoneNumber: requestedUserPhone,
					associatedVolunteer: {
						name: rawData.volunteerName,
						phone: rawData.volunteerNumber
					},
					action
				});
			}
			else {
				return;
			}
		}
	}

	let volunteer
	while (!volunteer) {
		volunteer = await getVolunteer(client, fullData);
		if (!volunteer) {
			await new Promise(resolve => setTimeout(resolve, 20 * 1000));
		}
	}

	await addToWaitingList({
		chatName: chat.name,
		date,
		phoneNumber: requestedUserPhone,
		associatedVolunteer: volunteer
	});

	console.log('handle_membership_request', {
		volunteerName: volunteer.name,
		volunteerNumber: volunteer.phone,
		chatName: chat.name,
		date: date,
		phoneNumber: requestedUserPhone
	});

	const message = fs.readFileSync('./files/message.txt', 'utf8')
		.replace('MANAGER_NAME', volunteer.name)
		.replace('PHONE_NUMBER', `+${volunteer.phone}`);

	await client.sendMessage(requestedUserId, message);

	const current_number_id = volunteer.phone.replace(/\D/g, '') + '@c.us';

	const messageForNewRequest = volunteerNewRequestMessage
		.replace('PHONE_NUMBER', `+${requestedUserPhone}`)
		.replace('CHAT_NAME', chat.name)
		.replace('chatId', chatId)
		.replace('author', requestedUserId);

	const poll = new Poll(messageForNewRequest, [PollOptions.APPROVE, PollOptions.DENY, PollOptions.NOT_ANSWERED], {allowMultipleAnswers: false});
	await client.sendMessage(current_number_id, poll);
}

async function handle_group_join(client, chatId, timestamp, recipient, action='הצטרף') {
	const date = new Date(timestamp * 1000);
	const chat = await client.getChatById(chatId);
	// await removeFromSheet(recipient, date.toLocaleDateString());
	await addUser({
		phoneNumber: recipient.replace(/\D/g, ''),
		date,
		action,
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
	let replyMessage = 'הפעולה בוצעה בהצלחה';
	if (selectedOption.name === PollOptions.APPROVE) {
		const result = await client.approveGroupMembershipRequests(chatId, { requesterIds: [userId] })
		replyMessage = approveMessage;
	}
	else {
		await client.rejectGroupMembershipRequests(chatId, {requesterIds: [userId]})
		let action = 'נדחה';
		if (selectedOption.name === PollOptions.NOT_ANSWERED) {
			action = 'לא הגיב';
			const link = 'https://chat.whatsapp.com/' + await chat.getInviteCode();
			await client.sendMessage(userId, notRespondMessage + link);
		}
		await addUser({
			phoneNumber: userId.replace(/\D/g, ''),
			date,
			action: 'נדחה',
			chatName: chat.name,
			associatedVolunteer: volunteer
		});
	}

	await parentMessage.reply(replyMessage.replace('PHONE_NUMBER', userId.replace(/\D/g, '')));

}

async function getVolunteer(client, fullSheetData) {
	let index = counter % volunteers.length;
	counter++;

	const volunteer =  volunteers[index];
	const chat = await client.getChatById(volunteer.phone + '@c.us');
	const lastMessages = await chat.fetchMessages({limit: 5});

	const pendingRequestsOfVolunteer = fullSheetData.filter((data) => data.volunteerPhone === volunteer.phone);

	if (lastMessages.length === 0) {
		return volunteer;
	}
	else {
		lastMessages.reverse();
		const lastPoll = lastMessages.find(message => message.type === 'poll_creation');
		const [chatId, userId] = getDataFromPoll(lastPoll);

		const lastMessage = lastMessages[0];

		if (userId) {
			if (!lastMessage.fromMe || await isPollAnswered(client, lastPoll.id._serialized)) {
				return volunteer;
			}
			else if(lastMessage.body === volunteersAlertMessage) {
				return;
			}
			else if (lastPoll.timestamp * 1000 < Date.now() - 1000 * 60 * 10 /* 10 minutes */) {
				await client.sendMessage(volunteer.phone + '@c.us', volunteersAlertMessage)
				// 	TODO Send Message to admin

				const group = await client.getChatById(chatId);
				const alreadyParticipant = group.participants.find(participant => participant.id._serialized === userId);

				if (!alreadyParticipant) {
					handle_membership_request(client, chatId, new Date(), userId).then();
				}
			}
			else if (lastMessage.timestamp * 1000 < Date.now() - 1000 * 60 * 3 /* 3 minutes */) {
				await client.sendMessage(volunteer.phone + '@c.us', volunteersReminderMessage);
			}
		} else {
			return volunteer;
		}
	}
	return undefined;
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
