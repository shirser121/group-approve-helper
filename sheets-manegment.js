const {google} = require('googleapis');
const fs = require('fs');

const credentials = JSON.parse(fs.readFileSync('./files/credentials.json').toString());

const {
	client_secret,
	client_id,
	redirect_uris
} = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const token = fs.readFileSync('./files/token.json').toString();
oAuth2Client.setCredentials(JSON.parse(token));


const spreadsheetId = '1YdltEUG9D8fXy2t_d3vlO3MskPAyGYqhDi6kI5mbJt0';

async function updateSheet(resource, sheetName) {
	const auth = oAuth2Client;
	const sheets = google.sheets({
		version: 'v4',
		auth
	});
	try {
		// const phoneNumber = resource.values[0][1];
		// const existingData = await sheets.spreadsheets.values.get({
		// 	spreadsheetId,
		// 	range: `${sheetName}!B:B`,
		// });

		// const existingPhoneNumbers = existingData.data.values ? existingData.data.values.flat() : [];

		// if (existingPhoneNumbers.includes(phoneNumber)) {
		//   console.log(`Phone number ${phoneNumber} already exists in the sheet. Not adding data.`);
		// } else {
		const response = await sheets.spreadsheets.values.append({
			spreadsheetId,
			range: `${sheetName}!A1`,
			valueInputOption: 'RAW',
			insertDataOption: 'INSERT_ROWS',
			resource,
		});
		console.log(`${response.data.updates.updatedCells} cells updated.`);
		// }
	} catch (error) {
		console.error('Error updating Google Sheets:', error.message);
	}
}


async function delSheet(phoneNumber, sheetName) {
	const auth = oAuth2Client;
	const sheets = google.sheets({
		version: 'v4',
		auth
	});
	let returnData = [];

	try {
		const existingData = await sheets.spreadsheets.values.get({
			spreadsheetId,
			range: `${sheetName}!B:B`,
		});

		const existingValues = existingData.data.values || [];
		let found = false;
		let rowIndexToDelete = -1;

		let index = 0;
		for (const row of existingValues) {
			if (row[0] === phoneNumber) {
				found = true;
				rowIndexToDelete = index;
				returnData = row;
				break;
			}
			index++;
		}


		if (found) {
			const response = await sheets.spreadsheets.values.clear({
				spreadsheetId,
				range: `${sheetName}!A${rowIndexToDelete + 1}:Z${rowIndexToDelete + 1}`,
			});
			console.log(`Phone number ${phoneNumber} found and row deleted. ${response.data.clearedRange} cleared.`);
		} else {
			console.log(`Phone number ${phoneNumber} not found. No action taken.`);
		}
	} catch (error) {
		console.error('Error deleting row from Google Sheets:', error.message);
	}

	return returnData;
}


async function getAllDataFromSheet(sheetName) {
	const auth = oAuth2Client;
	const sheets = google.sheets({
		version: 'v4',
		auth
	});
	try {
		const response = await sheets.spreadsheets.values.get({
			spreadsheetId,
			range: `${sheetName}!A:B`, // Assuming you want to retrieve all columns (A-Z)
		});

		const values = response.data.values;
		if (values.length) {
			return values;
		} else {
			console.log('No data found.');
			return [];
		}
	} catch (error) {
		console.error('Error retrieving data from Google Sheets:', error.message);
		return [];
	}
}


//When asking to join the group:
//Registers it in logs, registers it in a log that changes
//Enter, cell phone number, name, volunteer number, date and time added automatically


async function addToWaitingList({ associatedVolunteer, chatName, date, phoneNumber }) {
	const action = 'בקשת הצטרפות';
	const resource = {values: [[chatName, phoneNumber, date, associatedVolunteer.phone, associatedVolunteer.name, action]]};
	await updateSheet(resource, "log")
	await updateSheet(resource, "logWithChanges")
}


//When actually joining:
//Deletes it from the changing log
//Enter a cell phone number

async function addUser({ associatedVolunteer, chatName, date, phoneNumber, action}) {
	const data = await delSheet(phoneNumber, "logWithChanges")
	console.log(data);
	const resource = {values: [[chatName, phoneNumber, date, associatedVolunteer.phone, associatedVolunteer.name, action]]};
	await updateSheet(resource, "log")
}


//Accepting all volunteers
async function getAllVolunteers() {
	const volunteers = await getAllDataFromSheet("volunteers")
	if (volunteers.length === 0) {
		return {}
	}

	const fixedVolunteers = volunteers.slice(1).map(volunteer => {
		return {
			name: volunteer[0],
			phone: volunteer[1],
		}
	});

	return fixedVolunteers;
}

async function getAllWaitingList() {
	const waitingList = await getAllDataFromSheet("logWithChanges")
	if (waitingList.length === 0) {
		return {}
	}

	const fixedWaitingList = waitingList.slice(1).map(waiting => {
		return {
			groupName: waiting[0],
			phone: waiting[1],
			date: new Date(waiting[2]),
			volunteerPhone: waiting[3],
			volunteerName: waiting[4],
			action: waiting[5],
		}
	});

	return fixedWaitingList;
}


module.exports = {
	getAllVolunteers,
	addUser,
	addToWaitingList,
	getAllWaitingList
}


