// Selector-free offer location, tested against text captured from real
// issuer pages (trimmed). Each case is the page's visible text in reading
// order, as the browser returns it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateOffer } from '../src/locate.js';
import { parseOfferRegex } from '../src/parse.js';

const read = (text) => {
  const loc = locateOffer(text);
  return { loc, offer: loc && parseOfferRegex(loc.rawOfferText) };
};

test('headline split across lines, fee printed below (Chase)', () => {
  const { offer } = read(`CHASE SAPPHIRE PREFERRED® CREDIT CARD
Earn more than ever, same low annual fee.†
Earn 75,000 points
after you spend $5,000 in purchases in the first 3 months from account opening.*
Check for pre-approval
$95 annual fee†
Earn 100,000 bonus points after you spend $6,000 on purchases in the first 3 months from account opening`);
  assert.equal(offer.bonusAmount, 75000, 'the first complete statement wins, not a later cross-sell');
  assert.equal(offer.spendRequirement, 5000);
  assert.equal(offer.spendWindowDays, 90);
  assert.equal(offer.annualFee, 95);
  assert.equal(offer.confidence, 'high');
});

test('targeted "as high as" ceiling with fee printed above (Amex)', () => {
  const { offer } = read(`Annual Fee: $325
Welcome Offer & Key Details
AS HIGH AS 100,000
Membership Rewards® points
after you spend $8,000 in purchases on your new Card within the first 6 months of Card Membership.`);
  assert.equal(offer.bonusAmount, null);
  assert.equal(offer.bonusAmountMax, 100000);
  assert.equal(offer.isTargeted, true);
  assert.equal(offer.spendWindowDays, 180);
  assert.equal(offer.annualFee, 325);
});

test('cash bonus is not mistaken for the everyday earn rate (Chase Freedom)', () => {
  const { offer } = read(`$200 bonus*
1.5% or more on all purchases*
$0 annual fee†
Earn a $200 bonus after you spend $500 on purchases in the first 3 months from account opening.*`);
  assert.equal(offer.bonusAmount, 200);
  assert.equal(offer.bonusUnit, 'cash');
  assert.equal(offer.annualFee, 0);
});

test('UK copy: number words, pounds, Avios (Barclaycard)', () => {
  const { offer } = read(`A welcome bonus
If you’re new to Barclaycard, collect 25,000 Avios if you spend £3,000 in the first three months. T&Cs apply.`);
  assert.equal(offer.bonusAmount, 25000);
  assert.equal(offer.bonusUnit, 'avios');
  assert.equal(offer.spendCurrency, 'GBP');
  assert.equal(offer.spendWindowDays, 90);
});

test('screen-reader footnote labels inside the sentence are ignored (HSBC)', () => {
  const { offer } = read(`For a limited time, receive 70,000 reward points when you spend1 Footnote link 1 £2,000 on your card in the first 90 days of your card membership2 Footnote link 2 . Offer ends 1 December 2026
Annual fee £290`);
  assert.equal(offer.bonusAmount, 70000);
  assert.equal(offer.spendRequirement, 2000);
  assert.equal(offer.spendWindowDays, 90);
  assert.equal(offer.annualFee, 290);
});

test('"75K" headline shorthand reads as 75,000 (Capital One)', () => {
  const { offer } = read(`Enjoy a $300 stays credit, plus earn 75K bonus miles once you spend $4,000 on purchases within the first 3 months`);
  assert.equal(offer.bonusAmount, 75000);
  assert.equal(offer.bonusUnit, 'miles');
});

test('later offers on the page are counted, not merged in', () => {
  const { loc } = read(`Earn 75,000 points after you spend $5,000 in the first 3 months
You might also like
Earn 60,000 bonus points after spending $4,000 in the first 3 months`);
  assert.equal(loc.otherOfferCount, 1);
  assert.doesNotMatch(loc.rawOfferText, /60,000/);
});

test('a page with no bonus statement returns null', () => {
  assert.equal(locateOffer('This card is not currently available for new applications.'), null);
});

test('a non-standard offer is found and left for review', () => {
  const { offer } = read('Unlimited Cashback Match — we match all the cash back you earn in your first year.');
  assert.equal(offer.confidence, 'low');
});
