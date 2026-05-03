import { findPhoneNumbersInText } from 'libphonenumber-js';
const phones = findPhoneNumbersInText('Call me at 213-373-4253', 'US');
console.log(phones[0].number);
console.log(phones[0].number.number);
