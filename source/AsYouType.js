// This is an enhanced port of Google Android `libphonenumber`'s
// `asyoutypeformatter.js` of December 31th, 2018.
//
// https://github.com/googlei18n/libphonenumber/blob/8d21a365061de2ba0675c878a710a7b24f74d2ae/javascript/i18n/phonenumbers/asyoutypeformatter.js
//
// Simplified: does not differentiate between "local-only" numbers
// and "internationally dialable" numbers.
// For example, doesn't include changes like this:
// https://github.com/googlei18n/libphonenumber/commit/865da605da12b01053c4f053310bac7c5fbb7935

import Metadata from './metadata'

import PhoneNumber from './PhoneNumber'

import {
	VALID_DIGITS,
	VALID_PUNCTUATION,
	PLUS_CHARS
} from './constants'

import { matchesEntirely } from './util'

import {
	findCountryCode,
	extractNationalNumber,
	extractNationalNumberFromPossiblyIncompleteNumber,
	extractCountryCallingCode,
	extractCountryCallingCodeFromInternationalNumberWithoutPlusSign
} from './parse_'

import {
	FIRST_GROUP_PATTERN,
	formatNationalNumberUsingFormat,
	applyInternationalSeparatorStyle
} from './format_'

import { stripIDDPrefix } from './IDD'

import checkNumberLength from './checkNumberLength'

import parseDigits from './parseDigits'

// Used in phone number format template creation.
// Could be any digit, I guess.
const DUMMY_DIGIT = '9'
// I don't know why is it exactly `15`
const LONGEST_NATIONAL_PHONE_NUMBER_LENGTH = 15
// Create a phone number consisting only of the digit 9 that matches the
// `number_pattern` by applying the pattern to the "longest phone number" string.
const LONGEST_DUMMY_PHONE_NUMBER = repeat(DUMMY_DIGIT, LONGEST_NATIONAL_PHONE_NUMBER_LENGTH)

// The digits that have not been entered yet will be represented by a \u2008,
// the punctuation space.
export const DIGIT_PLACEHOLDER = 'x' // '\u2008' (punctuation space)
const DIGIT_PLACEHOLDER_MATCHER = new RegExp(DIGIT_PLACEHOLDER)

// A set of characters that, if found in a national prefix formatting rules, are an indicator to
// us that we should separate the national prefix from the number when formatting.
const NATIONAL_PREFIX_SEPARATORS_PATTERN = /[- ]/

// Deprecated: Google has removed some formatting pattern related code from their repo.
// https://github.com/googlei18n/libphonenumber/commit/a395b4fef3caf57c4bc5f082e1152a4d2bd0ba4c
// "We no longer have numbers in formatting matching patterns, only \d."
// Because this library supports generating custom metadata
// some users may still be using old metadata so the relevant
// code seems to stay until some next major version update.
const SUPPORT_LEGACY_FORMATTING_PATTERNS = true

// A pattern that is used to match character classes in regular expressions.
// An example of a character class is "[1-4]".
const CREATE_CHARACTER_CLASS_PATTERN = SUPPORT_LEGACY_FORMATTING_PATTERNS && (() => /\[([^\[\]])*\]/g)

// Any digit in a regular expression that actually denotes a digit. For
// example, in the regular expression "80[0-2]\d{6,10}", the first 2 digits
// (8 and 0) are standalone digits, but the rest are not.
// Two look-aheads are needed because the number following \\d could be a
// two-digit number, since the phone number can be as long as 15 digits.
const CREATE_STANDALONE_DIGIT_PATTERN = SUPPORT_LEGACY_FORMATTING_PATTERNS && (() => /\d(?=[^,}][^,}])/g)

// A pattern that is used to determine if a `format` is eligible
// to be used by the "as you type formatter".
// A `format` is eligible when it contains groups of a dollar sign
// followed by a single digit, separated by valid phone number punctuation.
// This prevents invalid punctuation (such as the star sign in Israeli star numbers)
// getting into the output of "as you type" formatter.
// Also, this prevents it from using formats that add additional digits to the output.
// For example, `AR` (Argentina) has this `format`:
// {
//    "pattern": "(\\d)(\\d{2})(\\d{4})(\\d{4})",
//    "leading_digits_patterns": ["91"],
//    "national_prefix_formatting_rule": "0$1",
//    "format": "$2 15-$3-$4",
//    "international_format": "$1 $2 $3-$4"
// },
// where `format` has `15` digits being added to the output.
// As You Type formatter can't add any digits to the output:
// the output must contain only those digits input by the user.
const ELIGIBLE_FORMAT_PATTERN = new RegExp(
	'^' +
	'[' + VALID_PUNCTUATION + ']*' +
	'(\\$\\d[' + VALID_PUNCTUATION + ']*)+' +
	'$'
)

// This is the minimum length of the leading digits of a phone number
// to guarantee the first "leading digits pattern" for a phone number format
// to be preemptive.
const MIN_LEADING_DIGITS_LENGTH = 3

const VALID_FORMATTED_PHONE_NUMBER_PART =
	'[' +
		VALID_PUNCTUATION +
		VALID_DIGITS +
	']+'

const VALID_FORMATTED_PHONE_NUMBER_PART_PATTERN = new RegExp('^' + VALID_FORMATTED_PHONE_NUMBER_PART + '$', 'i')

const VALID_PHONE_NUMBER =
	'(?:' +
		'[' + PLUS_CHARS + ']' +
		'[' +
			VALID_PUNCTUATION +
			VALID_DIGITS +
		']*' +
		'|' +
		'[' +
			VALID_PUNCTUATION +
			VALID_DIGITS +
		']+' +
	')'

const AFTER_PHONE_NUMBER_DIGITS_END_PATTERN = new RegExp(
	'[^' +
		VALID_PUNCTUATION +
		VALID_DIGITS +
	']+' +
	'.*' +
	'$'
)

const USE_NON_GEOGRAPHIC_COUNTRY_CODE = false

// Tests whether `national_prefix_for_parsing` could match
// different national prefixes.
// Not a digit, not a square bracket.
const COMPLEX_NATIONAL_PREFIX = /[^\d\[\]]/

export default class AsYouType {
	// Not setting `options` to a constructor argument
	// not to break backwards compatibility
	// for older versions of the library.
	options = {}

	/**
	 * @param {(string|object)?} [optionsOrDefaultCountry] - The default country used for parsing non-international phone numbers. Can also be an `options` object.
	 * @param {Object} metadata
	 */
	constructor(optionsOrDefaultCountry, metadata) {
		this.metadata = new Metadata(metadata)
		// Set `defaultCountry` and `defaultCallingCode` options.
		let defaultCountry
		let defaultCallingCode
		// Turns out `null` also has type "object". Weird.
		if (optionsOrDefaultCountry) {
			if (typeof optionsOrDefaultCountry === 'object') {
				defaultCountry = optionsOrDefaultCountry.defaultCountry
				defaultCallingCode = optionsOrDefaultCountry.defaultCallingCode
			} else {
				defaultCountry = optionsOrDefaultCountry
			}
		}
		if (defaultCountry && this.metadata.hasCountry(defaultCountry)) {
			this.defaultCountry = defaultCountry
		}
		if (defaultCallingCode) {
			/* istanbul ignore if */
			if (USE_NON_GEOGRAPHIC_COUNTRY_CODE) {
				if (this.metadata.isNonGeographicCallingCode(defaultCallingCode)) {
					this.defaultCountry = '001'
				}
			}
			this.defaultCallingCode = defaultCallingCode
		}
		// Reset.
		this.reset()
	}

	reset() {
		this.formattedOutput = ''
		this.international = false
		this.IDDPrefix = undefined
		this.countryCallingCode = undefined
		this.digits = ''
		this.resetExtractedNationalSignificantNumber()
		this.setCountry(this.defaultCountry, this.defaultCallingCode)
		return this
	}

	resetExtractedNationalSignificantNumber() {
		this.nationalSignificantNumber = this.getNationalPartOfDigits()
		this.nationalSignificantNumberMatchesInput = true
		this.nationalPrefix = undefined
		this.carrierCode = undefined
		this.prefixBeforeNationalSignificantNumber = undefined
		this.hasExtractedNationalSignificantNumber = undefined
	}

	resetFormat() {
		this.chosenFormat = undefined
		this.template = undefined
		this.nationalNumberTemplate = undefined
		this.populatedNationalNumberTemplate = undefined
		this.populatedNationalNumberTemplatePosition = -1
	}

	/**
	 * Returns `true` if the phone number is being input in international format.
	 * In other words, returns `true` if and only if the parsed phone number starts with a `"+"`.
	 * @return {boolean}
	 */
	isInternational() {
		return this.international
	}

	/**
	 * Returns the "country calling code" part of the phone number.
	 * Returns `undefined` if the number is not being input in international format.
	 * Returns "country calling code" for "non-geographic" phone numbering plans too.
	 * @return {string} [countryCallingCode]
	 */
	getCountryCallingCode() {
		return this.countryCallingCode
	}

	/**
	 * Returns a two-letter country code of the phone number.
	 * Returns `undefined` for "non-geographic" phone numbering plans.
	 * Returns `undefined` if no phone number has been input yet.
	 * @return {string} [country]
	 */
	getCountry() {
		// If no digits have been input yet,
		// then `this.country` is the `defaultCountry`.
		// Won't return the `defaultCountry` in such case.
		if (!this.digits) {
			return
		}
		let countryCode = this.country
		/* istanbul ignore if */
		if (USE_NON_GEOGRAPHIC_COUNTRY_CODE) {
			if (this.country === '001') {
				countryCode = undefined
			}
		}
		return countryCode
	}

	setCountry(country, callingCode) {
		this.country = country
		this.setCountryCallingCode(callingCode)
	}

	setCountryCallingCode(countryCallingCode) {
		this.countryCallingCode = countryCallingCode
		this.metadata.selectNumberingPlan(this.country, countryCallingCode)
		this.resetFormat()
		this.initializePhoneNumberFormatsForCountry()
		if (this.metadata.hasSelectedNumberingPlan()) {
			const nationalPrefixForParsing = this.metadata.numberingPlan._nationalPrefixForParsing()
			this.maybeCouldExtractAnotherNationalSignificantNumber = nationalPrefixForParsing && COMPLEX_NATIONAL_PREFIX.test(nationalPrefixForParsing)
			return true
		}
	}

	/**
	 * Inputs "next" phone number characters.
	 * @param  {string} text
	 * @return {string} Formatted phone number characters that have been input so far.
	 */
	input(text) {
		const [formattedDigits, hasPlus] = this.extractFormattedDigitsAndPlus(text)
		// Special case: just a leading `+` entered.
		if (!this.digits && hasPlus) {
			this.formattedOutput = '+'
			this.startInternationalNumber()
		}
		// If the extracted phone number part
		// can possibly be a part of some valid phone number
		// then parse phone number characters from a formatted phone number.
		if (VALID_FORMATTED_PHONE_NUMBER_PART_PATTERN.test(formattedDigits)) {
			const formattedNationalNumber = this.inputDigits(parseDigits(formattedDigits))
			this.formattedOutput = formattedNationalNumber
				? this.getFullNumber(formattedNationalNumber)
				: this.getNonFormattedNumber()
		}
		return this.formattedOutput
	}

	/**
	 * Extracts formatted phone number digits from text (if there're any).
	 * @param  {string} text
	 * @return {string}
	 */
	extractFormattedDigitsAndPlus(text) {
		// Extract a formatted phone number part from text.
		const extractedNumber = extractFormattedPhoneNumber(text) || ''
		// Trim a `+`.
		if (extractedNumber[0] === '+') {
			return [extractedNumber.slice('+'.length), true]
		}
		return [extractedNumber]
	}

	startInternationalNumber() {
		// Prepend the `+` to parsed input.
		this.international = true
		// If a default country was set then reset it
		// because an explicitly international phone
		// number is being entered.
		this.setCountry()
	}

	/**
	 * Inputs "next" phone number digits.
	 * @param  {string} digits
	 * @return {string} [formattedNumber] Formatted national phone number (if it can be formatted at this stage). Returning `undefined` means "don't format the national phone number at this stage".
	 */
	inputDigits(nextDigits) {
		const hasReceivedThreeLeadingDigits = this.digits.length < 3 && this.digits.length + nextDigits.length >= 3

		// Append phone number digits.
		this.digits += nextDigits

		// Attempt to extract IDD prefix:
		// Some users input their phone number in international format,
		// but in an "out-of-country" dialing format instead of using the leading `+`.
		// https://github.com/catamphetamine/libphonenumber-js/issues/185
		// Detect such numbers as soon as there're at least 3 digits.
		// Google's library attempts to extract IDD prefix at 3 digits.
		if (hasReceivedThreeLeadingDigits) {
			this.extractIDDPrefix()
		}

		if (this.isWaitingForCountryCallingCode()) {
			if (!this.extractCountryCallingCode()) {
				return
			}
		} else {
			this.nationalSignificantNumber += nextDigits
		}

		if (!this.hasExtractedNationalSignificantNumber) {
			// If a phone number is being input in international format,
			// then it's not valid for it to have a national prefix.
			// Still, some people incorrectly input such numbers with a national prefix.
			// In such cases, only attempt to strip a national prefix if the number becomes too long.
			// (but that is done later, not here)
			if (!this.isInternational()) {
				this.extractNationalSignificantNumber()
			}
		}

		// Match the available formats by the currently available leading digits.
		if (this.nationalSignificantNumber) {
			this.narrowDownPossibleFormats()
		}

		this.determineTheCountryIfNeeded()

		return this.format(nextDigits)
	}

	determineTheCountryIfNeeded() {
		// Suppose a user enters a phone number in international format,
		// and there're several countries corresponding to that country calling code,
		// and a country has been derived from the number, and then
		// a user enters one more digit and the number is no longer
		// valid for the derived country, so the country should be re-derived
		// on every new digit in those cases.
		//
		// If the phone number is being input in national format,
		// then it could be a case when `defaultCountry` wasn't specified
		// when creating `AsYouType` instance, and just `defaultCallingCode` was specified,
		// and that "calling code" could correspond to a "non-geographic entity",
		// or there could be several countries corresponding to that country calling code.
		// In those cases, `this.country` is `undefined` and should be derived
		// from the number. Again, if country calling code is ambiguous, then
		// `this.country` should be re-derived with each new digit.
		//
		if (!this.country || this.isCountryCallingCodeAmbiguous()) {
			this.determineTheCountry()
		}
	}

	format(nextDigits) {
		if (!this.metadata.hasSelectedNumberingPlan()) {
			return
		}

		// See if the phone number digits can be formatted as a complete phone number.
		// If not, use the results from `formatNationalNumberWithNextDigits()`,
		// which formats based on the chosen formatting pattern.
		//
		// Attempting to format complete phone number first is how it's done
		// in Google's `libphonenumber`, so this library just follows it.
		// Google's `libphonenumber` code doesn't explain in detail why does it
		// attempt to format digits as a complete phone number
		// instead of just going with a previoulsy (or newly) chosen `format`:
		//
		// "Checks to see if there is an exact pattern match for these digits.
		//  If so, we should use this instead of any other formatting template
		//  whose leadingDigitsPattern also matches the input."
		//
		// I could come up with my own example though where such
		// "attempt to format complete phone number" would solve an edge case:
		//
		// In some countries, the same digit could be a national prefix
		// or a leading digit of a valid phone number.
		// For example, in Russia, national prefix is `8`,
		// and also `800 555 35 35` is a valid number
		// in which `8` is not a national prefix, but the first digit
		// of a national (significant) number.
		// Suppose, a user starts inputting the `800 555 35 35` number,
		// and while it inputs it up to `800555353`, "as you type" formatter
		// extracts the national prefix `8` from the number, and then tries
		// to format national number `00555353` which is not a valid phone number
		// in Russia and doesn't match any of the available `format`s.
		// Then, as soon as the user inputs `5`, the number becomes `8005553535`,
		// which is a valid number in Russia provided no one strips the leading `8`
		// from it, mistaking it for a national prefix (which is also `8`).
		// And so, as soon as the user input `5`, AsYouType formatter attempts
		// to format "complete" phone number, finds out that it shouldn't strip
		// the national prefix, and doesn't strip it, resulting in a formatted
		// phone number: `800 555-35-35`.
		//
		return this.attemptToFormatCompletePhoneNumber() ||
			// Or, format the digits as a partial (incomplete) phone number
			// using the previously chosen formatting pattern (or a new one).
			this.formatNationalNumberWithNextDigits(nextDigits)
	}

	// Formats the next phone number digits.
	formatNationalNumberWithNextDigits(nextDigits) {
		const previouslyChosenFormat = this.chosenFormat
		// Choose a format from the list of matching ones.
		const newlyChosenFormat = this.chooseFormat()
		if (newlyChosenFormat) {
			if (newlyChosenFormat === previouslyChosenFormat) {
				// If it can format the next (current) digits
				// using the previously chosen phone number format
				// then return the updated formatted number.
				return this.formatNextNationalNumberDigits(nextDigits)
			} else {
				// If a more appropriate phone number format
				// has been chosen for these "leading digits",
				// then re-format the national phone number part
				// using the newly selected format.
				return this.formatNextNationalNumberDigits(this.getNationalPartOfDigits())
			}
		} else {
			// See if another national (significant) number could be re-extracted.
			if (this.reExtractNationalSignificantNumber()) {
				// If it could, then re-try formatting the new national (significant) number.
				return this.format(this.getNationalPartOfDigits())
			}
		}
	}

	reExtractNationalSignificantNumber() {
		// Attempt to extract a national prefix.
		//
		// Some people incorrectly input national prefix
		// in an international phone number.
		// For example, some people write British phone numbers as `+44(0)...`.
		//
		// Also, in some rare cases, it is valid for a national prefix
		// to be a part of an international phone number.
		// For example, mobile phone numbers in Mexico are supposed to be
		// dialled internationally using a `1` national prefix,
		// so the national prefix will be part of an international number.
		//
		// Quote from:
		// https://www.mexperience.com/dialing-cell-phones-in-mexico/
		//
		// "Dialing a Mexican cell phone from abroad
		// When you are calling a cell phone number in Mexico from outside Mexico,
		// it’s necessary to dial an additional “1” after Mexico’s country code
		// (which is “52”) and before the area code.
		// You also ignore the 045, and simply dial the area code and the
		// cell phone’s number.
		//
		// If you don’t add the “1”, you’ll receive a recorded announcement
		// asking you to redial using it.
		//
		// For example, if you are calling from the USA to a cell phone
		// in Mexico City, you would dial +52 – 1 – 55 – 1234 5678.
		// (Note that this is different to calling a land line in Mexico City
		// from abroad, where the number dialed would be +52 – 55 – 1234 5678)".
		//
		// Google's demo output:
		// https://libphonenumber.appspot.com/phonenumberparser?number=%2b5215512345678&country=MX
		//
		if (this.extractAnotherNationalSignificantNumber()) {
			return true
		}
		// If no format matches the phone number, then it could be
		// "a really long IDD" (quote from a comment in Google's library).
		// If the IDD is first extracted when the user has entered at least 3 digits,
		// then it could mean that "a really long IDD" is the one longer than 3 digits.
		// Could there be an IDD prefix longer than 3 digits? Seems like it could.
		// For example, in Australia the default IDD prefix is `0011`,
		// and it could even be as long as `14880011`.
		//
		// Could also check `!hasReceivedThreeLeadingDigits` here
		// to filter out the case when this check duplicates the one
		// already performed when there're 3 leading digits,
		// but it's not a big deal, and in most cases there
		// will be a suitable `format` when there're 3 leading digits.
		//
		if (this.extractIDDPrefix()) {
			return true
		}
	}

	/**
	 * Is only required to be called if there was another (non-empty)
	 * national (significant) number before the new one.
	 */
	onNationalSignificantNumberChanged() {
		this.determineTheCountryIfNeeded()
		// Reset all previous formatting data.
		// (and leading digits matching state)
		this.initializePhoneNumberFormatsForCountry()
		this.resetFormat()
		if (this.nationalSignificantNumber) {
			// Match the available formats by the currently available leading digits.
			this.narrowDownPossibleFormats()
		}
	}

	extractIDDPrefix() {
		// An IDD prefix can't be present in a number written with a `+`.
		// Also, don't re-extract an IDD prefix if has already been extracted.
		if (this.isInternational() || this.IDDPrefix) {
			return
		}
		// Some users input their phone number in "out-of-country"
		// dialing format instead of using the leading `+`.
		// https://github.com/catamphetamine/libphonenumber-js/issues/185
		// Detect such numbers.
		const numberWithoutIDD = stripIDDPrefix(
			this.digits,
			this.defaultCountry,
			this.defaultCallingCode,
			this.metadata.metadata
		)
		if (numberWithoutIDD && numberWithoutIDD !== this.digits) {
			// If an IDD prefix was stripped then convert the IDD-prefixed number
			// to international number for subsequent parsing.
			this.IDDPrefix = this.digits.slice(0, this.digits.length - numberWithoutIDD.length)
			this.startInternationalNumber()
			if (this.nationalSignificantNumber) {
				this.resetExtractedNationalSignificantNumber()
				this.onNationalSignificantNumberChanged()
			}
			return true
		}
	}

	chooseFormat() {
		// When there are multiple available formats, the formatter uses the first
		// format where a formatting template could be created.
		for (const format of this.matchingFormats) {
			// If this format is currently being used
			// and is still possible, then stick to it.
			if (this.chosenFormat === format) {
				break
			}
			if (!this.createFormattingTemplate(format)) {
				continue
			}
			this.chosenFormat = format
			break
		}
		if (!this.chosenFormat) {
			// No format matches the national phone number entered.
			this.resetFormat()
		}
		return this.chosenFormat
	}

	initializePhoneNumberFormatsForCountry() {
		if (this.metadata.hasSelectedNumberingPlan()) {
			// Get all "eligible" phone number formats for this country.
			// The the comments on `ELIGIBLE_FORMAT_PATTERN` for a definition
			// of an "eligible" format.
			// International format of a format is checked here,
			// because it's used both when formatting international
			// and non-international numbers.
			// It's assumed that an international format is always more
			// "eligible" than a national format.
			this.matchingFormats = this.metadata.formats().filter((format) => {
				return ELIGIBLE_FORMAT_PATTERN.test(format.internationalFormat())
			})
		} else {
			this.matchingFormats = []
		}
	}

	narrowDownPossibleFormats() {
		const leadingDigits = this.nationalSignificantNumber
		// "leading digits" pattern list starts with a
		// "leading digits" pattern fitting a maximum of 3 leading digits.
		// So, after a user inputs 3 digits of a national (significant) phone number
		// this national (significant) number can already be formatted.
		// The next "leading digits" pattern is for 4 leading digits max,
		// and the "leading digits" pattern after it is for 5 leading digits max, etc.

		// This implementation is different from Google's
		// in that it searches for a fitting format
		// even if the user has entered less than
		// `MIN_LEADING_DIGITS_LENGTH` digits of a national number.
		// Because some leading digit patterns already match for a single first digit.
		let leadingDigitsPatternIndex = leadingDigits.length - MIN_LEADING_DIGITS_LENGTH
		if (leadingDigitsPatternIndex < 0) {
			leadingDigitsPatternIndex = 0
		}

		this.matchingFormats = this.matchingFormats.filter((format) => {
			// If national prefix is not used when formatting a phone number
			// using this format, but a national prefix has been entered by the user,
			// and was extracted, then discard such phone number format.
			// In Google's "AsYouType" formatter code, the equivalent would be this part:
			// https://github.com/google/libphonenumber/blob/0a45cfd96e71cad8edb0e162a70fcc8bd9728933/java/libphonenumber/src/com/google/i18n/phonenumbers/AsYouTypeFormatter.java#L175-L184
			if (this.nationalPrefix &&
				!format.usesNationalPrefix() &&
				// !format.domesticCarrierCodeFormattingRule() &&
				!format.nationalPrefixIsOptionalWhenFormattingInNationalFormat()) {
				return false
			}
			// If national prefix is mandatory for this phone number format
			// and there're no guarantees that a national prefix is present in user input
			// then discard this phone number format as not suitable.
			// In Google's "AsYouType" formatter code, the equivalent would be this part:
			// https://github.com/google/libphonenumber/blob/0a45cfd96e71cad8edb0e162a70fcc8bd9728933/java/libphonenumber/src/com/google/i18n/phonenumbers/AsYouTypeFormatter.java#L185-L193
			if (!this.isInternational() &&
				!this.nationalPrefix &&
				format.nationalPrefixIsMandatoryWhenFormattingInNationalFormat()) {
				return false
			}
			const leadingDigitsPatternsCount = format.leadingDigitsPatterns().length
			// If this format is not restricted to a certain
			// leading digits pattern then it fits.
			if (leadingDigitsPatternsCount === 0) {
				return true
			}
			// Start excluding any non-matching formats only when the
			// national number entered so far is at least 3 digits long,
			// otherwise format matching would give false negatives.
			// For example, when the digits entered so far are `2`
			// and the leading digits pattern is `21` –
			// it's quite obvious in this case that the format could be the one
			// but due to the absence of further digits it would give false negative.
			if (leadingDigits.length < MIN_LEADING_DIGITS_LENGTH) {
				return true
			}
			// If at least `MIN_LEADING_DIGITS_LENGTH` digits of a national number are available
			// then format matching starts narrowing down the list of possible formats
			// (only previously matched formats are considered for next digits).
			leadingDigitsPatternIndex = Math.min(leadingDigitsPatternIndex, leadingDigitsPatternsCount - 1)
			const leadingDigitsPattern = format.leadingDigitsPatterns()[leadingDigitsPatternIndex]
			// Brackets are required for `^` to be applied to
			// all or-ed (`|`) parts, not just the first one.
			return new RegExp(`^(${leadingDigitsPattern})`).test(leadingDigits)
		})

		// If there was a phone number format chosen
		// and it no longer holds given the new leading digits then reset it.
		// The test for this `if` condition is marked as:
		// "Reset a chosen format when it no longer holds given the new leading digits".
		// To construct a valid test case for this one can find a country
		// in `PhoneNumberMetadata.xml` yielding one format for 3 `<leadingDigits>`
		// and yielding another format for 4 `<leadingDigits>` (Australia in this case).
		if (this.chosenFormat && this.matchingFormats.indexOf(this.chosenFormat) === -1) {
			this.resetFormat()
		}
	}

	getSeparatorAfterNationalPrefix(format) {
		// `US` metadata doesn't have a `national_prefix_formatting_rule`,
		// so the `if` condition below doesn't apply to `US`,
		// but in reality there shoudl be a separator
		// between a national prefix and a national (significant) number.
		// So `US` national prefix separator is a "special" "hardcoded" case.
		if (this.metadata.countryCallingCode() === '1') {
			return ' '
		}
		// If a `format` has a `national_prefix_formatting_rule`
		// and that rule has a separator after a national prefix,
		// then it means that there should be a separator
		// between a national prefix and a national (significant) number.
		if (format &&
			format.nationalPrefixFormattingRule() &&
			NATIONAL_PREFIX_SEPARATORS_PATTERN.test(format.nationalPrefixFormattingRule())) {
			return ' '
		}
		// At this point, there seems to be no clear evidence that
		// there should be a separator between a national prefix
		// and a national (significant) number. So don't insert one.
		return ''
	}

	// This is in accordance to how Google's `libphonenumber` does it.
	// "Check to see if there is an exact pattern match for these digits.
	// If so, we should use this instead of any other formatting template
	// whose `leadingDigitsPattern` also matches the input."
	attemptToFormatCompletePhoneNumber() {
		const nationalPrefix = this.nationalPrefix
		const carrierCode = this.carrierCode
		const nationalNumber = this.nationalSignificantNumber
		if (checkNumberLength(nationalNumber, this.metadata) !== 'IS_POSSIBLE') {
			return
		}
		for (const format of this.matchingFormats) {
			const matcher = new RegExp(`^(?:${format.pattern()})$`)
			if (!matcher.test(nationalNumber)) {
				continue
			}
			const formattedNationalNumber = this.formatNationalNumberUsingFormat(
				nationalPrefix,
				carrierCode,
				nationalNumber,
				format
			)
			if (!formattedNationalNumber) {
				continue
			}
			// To leave the formatter in a consistent state.
			this.resetFormat()
			this.chosenFormat = format
			// Set `this.template` and `this.populatedNationalNumberTemplate`.
			/* istanbul ignore else */
			if (this.createFormattingTemplate(format)) {
				// Populate `this.populatedNationalNumberTemplate` with phone number digits.
				this.formatNextNationalNumberDigits(this.getNationalPartOfDigits())
			} else {
				// This case doesn't ever happen with the current metadata.
				// If the formatting template couldn't be created for a format,
				// create it manually from the formatted phone number.
				this.template = this.getFullNumber(formattedNationalNumber).replace(/[\d\+]/g, DIGIT_PLACEHOLDER)
				this.nationalNumberTemplate = formattedNationalNumber.replace(/[\d\+]/g, DIGIT_PLACEHOLDER)
				this.populatedNationalNumberTemplate = formattedNationalNumber
				this.populatedNationalNumberTemplatePosition = this.populatedNationalNumberTemplate.length - 1
			}
			return formattedNationalNumber
		}
	}

	formatNationalNumberUsingFormat(nationalPrefix, carrierCode, nationalNumber, format) {
		if (nationalPrefix) {
			// Here, the number is formatted using a "national prefix formatting rule",
			// and if the formatted number is a valid formatted number, then it's returned.
			// Google's AsYouType formatter is different in a way that it doesn't try
			// to format using the "national prefix formatting rule", and instead it
			// simply prepends a national prefix followed by a " " character.
			// This code does that too, but as a fallback.
			// The reason is that "national prefix formatting rule" may use parentheses,
			// which wouldn't be included has it used the simpler Google's way.
			const formattedNumber = formatNationalNumberUsingFormat(
				nationalNumber,
				format,
				{
					internationalFormat: this.isInternational(),
					withNationalPrefix: true,
					carrierCode: carrierCode,
					metadata: this.metadata
				}
			)
			if (this.isValidFormattedNationalNumber(formattedNumber)) {
				return formattedNumber
			}
		}
		let formattedNumber = formatNationalNumberUsingFormat(
			nationalNumber,
			format,
			{
				internationalFormat: this.isInternational(),
				withNationalPrefix: false,
				carrierCode,
				metadata: this.metadata
			}
		)
		// If a national prefix was extracted, then just prepend it,
		// followed by a " " character.
		// If `nationalPrefix` is `undefined`, then it doesn't imply
		// that a national prefix wasn't extracted: it might have been extracted
		// if there's a `national_prefix_formatting_pattern` having "capturing groups".
		if (nationalPrefix) {
			formattedNumber = nationalPrefix +
				this.getSeparatorAfterNationalPrefix(format) +
				formattedNumber
		}
		if (this.isValidFormattedNationalNumber(formattedNumber)) {
			return formattedNumber
		}
	}

	// Check that the formatted phone number contains exactly
	// the same digits that have been input by the user.
	// For example, when "0111523456789" is input for `AR` country,
	// the extracted `this.nationalSignificantNumber` is "91123456789",
	// which means that the national part of `this.digits` isn't simply equal to
	// `this.nationalPrefix` + `this.nationalSignificantNumber`.
	//
	// Also, a `format` can add extra digits to the `this.nationalSignificantNumber`
	// being formatted via `metadata[country].national_prefix_transform_rule`.
	// For example, for `VI` country, it prepends `340` to the national number,
	// and if this check hasn't been implemented, then there would be a bug
	// when `340` "area coude" is "duplicated" during input for `VI` country:
	// https://github.com/catamphetamine/libphonenumber-js/issues/318
	//
	// So, all these "gotchas" are filtered out.
	//
	// In the original Google's code, the comments say:
	// "Check that we didn't remove nor add any extra digits when we matched
	// this formatting pattern. This usually happens after we entered the last
	// digit during AYTF. Eg: In case of MX, we swallow mobile token (1) when
	// formatted but AYTF should retain all the number entered and not change
	// in order to match a format (of same leading digits and length) display
	// in that way."
	// "If it's the same (i.e entered number and format is same), then it's
	// safe to return this in formatted number as nothing is lost / added."
	// Otherwise, don't use this format.
	// https://github.com/google/libphonenumber/commit/3e7c1f04f5e7200f87fb131e6f85c6e99d60f510#diff-9149457fa9f5d608a11bb975c6ef4bc5
	// https://github.com/google/libphonenumber/commit/3ac88c7106e7dcb553bcc794b15f19185928a1c6#diff-2dcb77e833422ee304da348b905cde0b
	//
	isValidFormattedNationalNumber(formattedNationalNumber) {
		return parseDigits(formattedNationalNumber) === this.getNationalPartOfDigits()
	}

	/**
	 * Returns the part of `this.digits` that corresponds to the national number.
	 * Basically, all digits that have been input by the user, except for the
	 * international prefix and the country calling code part
	 * (if the number is an international one).
	 * @return {string}
	 */
	getNationalPartOfDigits() {
		if (this.isInternational()) {
			return this.digits.slice(
				(this.IDDPrefix ? this.IDDPrefix.length : 0) +
				(this.countryCallingCode ? this.countryCallingCode.length : 0)
			)
		}
		return this.digits
	}

	getDigitsWithoutInternationalPrefix() {
		if (this.isInternational()) {
			if (this.IDDPrefix) {
				return this.digits.slice(this.IDDPrefix.length)
			}
		}
		return this.digits
	}

	getInternationalPrefixBeforeCountryCallingCode(options) {
		return this.IDDPrefix ? (
			options && options.spacing === false ? this.IDDPrefix : this.IDDPrefix + ' '
		) : '+'
	}

	// Prepends `+CountryCode ` in case of an international phone number
	getFullNumber(formattedNationalNumber) {
		if (this.isInternational()) {
			const prefix = this.getInternationalPrefixBeforeCountryCallingCode()
			if (!this.countryCallingCode) {
				return `${prefix}${this.getDigitsWithoutInternationalPrefix()}`
			}
			if (!formattedNationalNumber) {
				return `${prefix}${this.countryCallingCode}`
			}
			return `${prefix}${this.countryCallingCode} ${formattedNationalNumber}`
		}
		return formattedNationalNumber
	}

	getNonFormattedNationalNumber() {
		let number = this.nationalSignificantNumber
		const prefix = this.prefixBeforeNationalSignificantNumber || this.nationalPrefix
		if (prefix) {
			number = prefix + number
		}
		return number
	}

	getNonFormattedNumber() {
		return this.getFullNumber(
			this.nationalSignificantNumberMatchesInput
				? this.getNonFormattedNationalNumber()
				: this.getNationalPartOfDigits()
		)
	}

	isWaitingForCountryCallingCode() {
		return this.isInternational() && !this.countryCallingCode
	}

	// Extracts a country calling code from a number
	// being entered in internatonal format.
	extractCountryCallingCode() {
		const { countryCallingCode, number } = extractCountryCallingCode(
			'+' + this.getDigitsWithoutInternationalPrefix(),
			this.defaultCountry,
			this.defaultCallingCode,
			this.metadata.metadata
		)
		if (countryCallingCode) {
			this.setCountryCallingCode(countryCallingCode)
			this.nationalSignificantNumber = number
			return true
		}
	}

	/**
	 * Extracts a national (significant) number from user input.
	 * Google's library is different in that it only applies `national_prefix_for_parsing`
	 * and doesn't apply `national_prefix_transform_rule` after that.
	 * https://github.com/google/libphonenumber/blob/a3d70b0487875475e6ad659af404943211d26456/java/libphonenumber/src/com/google/i18n/phonenumbers/AsYouTypeFormatter.java#L539
	 * @return {boolean} [extracted]
	 */
	extractNationalSignificantNumber() {
		if (!this.metadata.hasSelectedNumberingPlan()) {
			return
		}
		const {
			nationalNumber,
			nationalPrefix,
			carrierCode
		} = extractNationalNumberFromPossiblyIncompleteNumber(
			this.nationalSignificantNumber,
			this.metadata
		)
		if (nationalNumber === this.nationalSignificantNumber) {
			return
		}
		this.onExtractedNationalNumber(
			nationalPrefix,
			carrierCode,
			nationalNumber
		)
		return true
	}

	/**
	 * In Google's code this function is called "attempt to extract longer NDD".
	 * "Some national prefixes are a substring of others", they say.
	 * @return {boolean} [result] — Returns `true` if extracting a national prefix produced different results from what they were.
	 */
	extractAnotherNationalSignificantNumber() {
		if (!this.hasExtractedNationalSignificantNumber) {
			return this.extractNationalSignificantNumber()
		}
		if (!this.maybeCouldExtractAnotherNationalSignificantNumber) {
			return
		}
		const {
			nationalNumber,
			nationalPrefix,
			carrierCode
		} = extractNationalNumberFromPossiblyIncompleteNumber(
			this.getNationalPartOfDigits(),
			this.metadata
		)
		if (nationalNumber === this.nationalSignificantNumber) {
			return
		}
		this.onExtractedNationalNumber(
			nationalPrefix,
			carrierCode,
			nationalNumber
		)
		return true
	}

	onExtractedNationalNumber(
		nationalPrefix,
		carrierCode,
		nationalNumber
	) {
		// Not returning a `nationalPrefix` doesn't imply
		// that the original phone number didn't contain it.
		// https://gitlab.com/catamphetamine/libphonenumber-js/-/blob/master/METADATA.md#national_prefix_for_parsing--national_prefix_transform_rule
		if (nationalPrefix) {
			this.nationalPrefix = nationalPrefix
		}
		if (carrierCode) {
			this.carrierCode = carrierCode
		}
		this.nationalSignificantNumber = nationalNumber
		this.prefixBeforeNationalSignificantNumber = undefined
		this.nationalSignificantNumberMatchesInput = undefined
		const digits = this.getNationalPartOfDigits()
		// This check also works with empty `this.nationalSignificantNumber`.
		const nationalNumberIndex = digits.lastIndexOf(nationalNumber)
		if (nationalNumberIndex === digits.length - nationalNumber.length) {
			this.nationalSignificantNumberMatchesInput = true
			// If a prefix of a national (significant) number is not as simple
			// as just a basic national prefix, then such prefix is stored in
			// `this.prefixBeforeNationalSignificantNumber` property and will be
			// prepended "as is" to the national (significant) number to produce
			// a formatted result.
			if (digits !== (nationalPrefix + '') + nationalNumber) {
				this.prefixBeforeNationalSignificantNumber = digits.slice(0, nationalNumberIndex)
			}
		}

		this.hasExtractedNationalSignificantNumber = true
		this.onNationalSignificantNumberChanged()
	}

	isCountryCallingCodeAmbiguous() {
		const countryCodes = this.metadata.getCountryCodesForCallingCode(this.countryCallingCode)
		return countryCodes && countryCodes.length > 1
	}

	createFormattingTemplate(format) {
		// The formatter doesn't format numbers when numberPattern contains '|', e.g.
		// (20|3)\d{4}. In those cases we quickly return.
		// (Though there's no such format in current metadata)
		/* istanbul ignore if */
		if (SUPPORT_LEGACY_FORMATTING_PATTERNS && format.pattern().indexOf('|') >= 0) {
			return
		}
		// Get formatting template for this phone number format
		let template = this.getTemplateForNumberFormatPattern(format)
		// If the national number entered is too long
		// for any phone number format, then abort.
		if (!template) {
			return
		}
		this.template = template
		this.nationalNumberTemplate = template
		this.populatedNationalNumberTemplate = template
		// With a new formatting template, the matched position
		// using the old template needs to be reset.
		this.populatedNationalNumberTemplatePosition = -1
		// For convenience, the public `.template` property
		// contains the whole international number
		// if the phone number being input is international:
		// 'x' for the '+' sign, 'x'es for the country phone code,
		// a spacebar and then the template for the formatted national number.
		if (this.isInternational()) {
			this.template =
				this.getInternationalPrefixBeforeCountryCallingCode().replace(/[\d\+]/g, DIGIT_PLACEHOLDER) +
				repeat(DIGIT_PLACEHOLDER, this.countryCallingCode.length) +
				' ' +
				template
		}
		return true
	}

	/**
	 * Generates formatting template for a national phone number,
	 * optionally containing a national prefix, for a format.
	 * @param  {Format} format
	 * @param  {string} nationalPrefix
	 * @return {string}
	 */
	getTemplateForNumberFormatPattern(format) {
		let pattern = format.pattern()

		/* istanbul ignore else */
		if (SUPPORT_LEGACY_FORMATTING_PATTERNS) {
			pattern = pattern
				// Replace anything in the form of [..] with \d
				.replace(CREATE_CHARACTER_CLASS_PATTERN(), '\\d')
				// Replace any standalone digit (not the one in `{}`) with \d
				.replace(CREATE_STANDALONE_DIGIT_PATTERN(), '\\d')
		}

		// Generate a dummy national number (consisting of `9`s)
		// that fits this format's `pattern`.
		//
		// This match will always succeed,
		// because the "longest dummy phone number"
		// has enough length to accomodate any possible
		// national phone number format pattern.
		//
		let digits = LONGEST_DUMMY_PHONE_NUMBER.match(pattern)[0]

		// If the national number entered is too long
		// for any phone number format, then abort.
		if (this.nationalSignificantNumber.length > digits.length) {
			return
		}

		// Get a formatting template which can be used to efficiently format
		// a partial number where digits are added one by one.

		// Below `strictPattern` is used for the
		// regular expression (with `^` and `$`).
		// This wasn't originally in Google's `libphonenumber`
		// and I guess they don't really need it
		// because they're not using "templates" to format phone numbers
		// but I added `strictPattern` after encountering
		// South Korean phone number formatting bug.
		//
		// Non-strict regular expression bug demonstration:
		//
		// this.nationalSignificantNumber : `111111111` (9 digits)
		//
		// pattern : (\d{2})(\d{3,4})(\d{4})
		// format : `$1 $2 $3`
		// digits : `9999999999` (10 digits)
		//
		// '9999999999'.replace(new RegExp(/(\d{2})(\d{3,4})(\d{4})/g), '$1 $2 $3') = "99 9999 9999"
		//
		// template : xx xxxx xxxx
		//
		// But the correct template in this case is `xx xxx xxxx`.
		// The template was generated incorrectly because of the
		// `{3,4}` variability in the `pattern`.
		//
		// The fix is, if `this.nationalSignificantNumber` has already sufficient length
		// to satisfy the `pattern` completely then `this.nationalSignificantNumber`
		// is used instead of `digits`.

		const strictPattern = new RegExp('^' + pattern + '$')
		const nationalNumberDummyDigits = this.nationalSignificantNumber.replace(/\d/g, DUMMY_DIGIT)

		// If `this.nationalSignificantNumber` has already sufficient length
		// to satisfy the `pattern` completely then use it
		// instead of `digits`.
		if (strictPattern.test(nationalNumberDummyDigits)) {
			digits = nationalNumberDummyDigits
		}

		let numberFormat = this.getFormatFormat(format)
		let nationalPrefixIncludedInTemplate

		// If a user did input a national prefix,
		// and if a `format` does have a national prefix formatting rule,
		// then see if that national prefix formatting rule
		// prepends exactly the same national prefix the user has input.
		// If that's the case, then use the `format` with the national prefix formatting rule.
		// Otherwise, use  the `format` without the national prefix formatting rule,
		// and prepend a national prefix manually to it.
		if (this.nationalPrefix && !this.prefixBeforeNationalSignificantNumber) {
			if (format.nationalPrefixFormattingRule()) {
				const numberFormatWithNationalPrefix = numberFormat.replace(
					FIRST_GROUP_PATTERN,
					format.nationalPrefixFormattingRule()
				)
				// If `national_prefix_formatting_rule` of a `format` simply prepends
				// national prefix at the start of a national (significant) number,
				// then such formatting can be used with `AsYouType` formatter.
				// There seems to be no `else` case: everywhere in metadata,
				// national prefix formatting rule is national prefix + $1,
				// or `($1)`, in which case such format isn't even considered
				// when the user has input a national prefix.
				/* istanbul ignore else */
				if (parseDigits(format.nationalPrefixFormattingRule()) === this.nationalPrefix + parseDigits('$1')) {
					numberFormat = numberFormatWithNationalPrefix
					nationalPrefixIncludedInTemplate = true
					// Replace all digits of the national prefix in the formatting template
					// with `DIGIT_PLACEHOLDER`s.
					let i = this.nationalPrefix.length
					while (i > 0) {
						numberFormat = numberFormat.replace(/\d/, DIGIT_PLACEHOLDER)
						i--
					}
				}
			}
		}

		// Generate formatting template for this phone number format.
		let template = digits
			// Format the dummy phone number according to the format.
			.replace(new RegExp(pattern), numberFormat)
			// Replace each dummy digit with a DIGIT_PLACEHOLDER.
			.replace(new RegExp(DUMMY_DIGIT, 'g'), DIGIT_PLACEHOLDER)

		// If a prefix of a national (significant) number is not as simple
		// as just a basic national prefix, then just prepend such prefix
		// before the national (significant) number, optionally spacing
		// the two with a whitespace.
		if (this.prefixBeforeNationalSignificantNumber) {
			// Prepend the prefix to the template manually.
			// Using the same separator as for a national prefix (for no specific reason).
			template = repeat(DIGIT_PLACEHOLDER, this.prefixBeforeNationalSignificantNumber.length) +
				this.getSeparatorAfterNationalPrefix(format) +
				template
		} else if (this.nationalPrefix) {
			if (!nationalPrefixIncludedInTemplate) {
				// Prepend national prefix to the template manually.
				template = repeat(DIGIT_PLACEHOLDER, this.nationalPrefix.length) +
					this.getSeparatorAfterNationalPrefix(format) +
					template
			}
		}

		return template
	}

	formatNextNationalNumberDigits(digits) {
		const result = populateTemplateWithDigits(
			this.populatedNationalNumberTemplate,
			this.populatedNationalNumberTemplatePosition,
			digits
		)

		if (!result) {
			// Reset the format.
			this.resetFormat()
			return
		}

		this.populatedNationalNumberTemplate = result[0]
		this.populatedNationalNumberTemplatePosition = result[1]

		// Return the formatted phone number so far.
		return cutAndStripNonPairedParens(this.populatedNationalNumberTemplate, this.populatedNationalNumberTemplatePosition + 1)

		// The old way which was good for `input-format` but is not so good
		// for `react-phone-number-input`'s default input (`InputBasic`).
		// return closeNonPairedParens(this.populatedNationalNumberTemplate, this.populatedNationalNumberTemplatePosition + 1)
		// 	.replace(new RegExp(DIGIT_PLACEHOLDER, 'g'), ' ')
	}

	getFormatFormat(format) {
		if (this.isInternational()) {
			return applyInternationalSeparatorStyle(format.internationalFormat())
		}
		// Sometimes, national formatting rule contains additional digits
		// that are inserted in a phone number, and "as you type" formatter can't do that.
		if (ELIGIBLE_FORMAT_PATTERN.test(format.format())) {
			return format.format()
		}
		return format.internationalFormat()
	}

	// Determines the country of the phone number
	// entered so far based on the country phone code
	// and the national phone number.
	determineTheCountry() {
		this.country = findCountryCode(
			this.isInternational() ? this.countryCallingCode : this.defaultCallingCode,
			this.nationalSignificantNumber,
			this.metadata
		)
	}

	/**
	 * Returns an instance of `PhoneNumber` class.
	 * Will return `undefined` if no national (significant) number
	 * digits have been entered so far, or if no `defaultCountry` has been
	 * set and the user enters a phone number not in international format.
	 */
	getNumber() {
		if (this.isInternational()) {
			if (!this.countryCallingCode) {
				return
			}
		} else {
			if (!this.country && !this.defaultCallingCode) {
				return
			}
		}
		if (!this.nationalSignificantNumber) {
			return undefined
		}
		let countryCode = this.getCountry()
		const callingCode = this.getCountryCallingCode() || this.defaultCallingCode
		let nationalNumber = this.nationalSignificantNumber
		let carrierCode = this.carrierCode
		// Google's AsYouType formatter supports sort of an "autocorrection" feature
		// when it "autocorrects" numbers that have been input for a country
		// with that country's calling code.
		// Such "autocorrection" feature looks weird, but different people have been requesting it:
		// https://github.com/catamphetamine/libphonenumber-js/issues/376
		// https://github.com/catamphetamine/libphonenumber-js/issues/375
		// https://github.com/catamphetamine/libphonenumber-js/issues/316
		if (!this.isInternational() && this.nationalSignificantNumber === this.digits) {
			const {
				countryCallingCode,
				number
			} = extractCountryCallingCodeFromInternationalNumberWithoutPlusSign(
				this.digits,
				countryCode,
				callingCode,
				this.metadata.metadata
			)
			if (countryCallingCode) {
				const {
					nationalNumber: newNationalNumber,
					carrierCode: newCarrierCode
				} = extractNationalNumber(
					number,
					this.metadata
				)
				nationalNumber = newNationalNumber
				carrierCode = newCarrierCode
			}
		}
		const phoneNumber = new PhoneNumber(
			countryCode || callingCode,
			nationalNumber,
			this.metadata.metadata
		)
		if (carrierCode) {
			phoneNumber.carrierCode = carrierCode
		}
		// Phone number extensions are not supported by "As You Type" formatter.
		return phoneNumber
	}

	/**
	 * Returns `true` if the phone number is "possible".
	 * Is just a shortcut for `PhoneNumber.isPossible()`.
	 * @return {boolean}
	 */
	isPossible() {
		const phoneNumber = this.getNumber()
		if (!phoneNumber) {
			return false
		}
		return phoneNumber.isPossible()
	}

	/**
	 * Returns `true` if the phone number is "valid".
	 * Is just a shortcut for `PhoneNumber.isValid()`.
	 * @return {boolean}
	 */
	isValid() {
		const phoneNumber = this.getNumber()
		if (!phoneNumber) {
			return false
		}
		return phoneNumber.isValid()
	}

	/**
	 * @deprecated
	 * This method is used in `react-phone-number-input/source/input-control.js`
	 * in versions before `3.0.16`.
	 */
	getNationalNumber() {
		return this.nationalSignificantNumber
	}

	getNonFormattedTemplate() {
		return this.getNonFormattedNumber().replace(/[\+\d]/g, DIGIT_PLACEHOLDER)
	}

	/**
	 * Returns the template for the formatted phone number.
	 * @return {string} [template]
	 */
	getTemplate() {
		if (!this.template) {
			return this.getNonFormattedTemplate()
		}
		// `this.template` holds the template for a "complete" phone number.
		// The currently entered phone number is most likely not "complete",
		// so trim all non-populated digits.
		let index = -1
		let i = 0
		while (i < (this.isInternational() ? this.getInternationalPrefixBeforeCountryCallingCode({ spacing: false }).length : 0) + this.getDigitsWithoutInternationalPrefix().length) {
			index = this.template.indexOf(DIGIT_PLACEHOLDER, index + 1)
			i++
		}
		return cutAndStripNonPairedParens(this.template, index + 1)
	}
}

export function stripNonPairedParens(string) {
	const dangling_braces =[]
	let i = 0
	while (i < string.length) {
		if (string[i] === '(') {
			dangling_braces.push(i)
		}
		else if (string[i] === ')') {
			dangling_braces.pop()
		}
		i++
	}
	let start = 0
	let cleared_string = ''
	dangling_braces.push(string.length)
	for (const index of dangling_braces) {
		cleared_string += string.slice(start, index)
		start = index + 1
	}
	return cleared_string
}

export function cutAndStripNonPairedParens(string, cutBeforeIndex) {
	if (string[cutBeforeIndex] === ')') {
		cutBeforeIndex++
	}
	return stripNonPairedParens(string.slice(0, cutBeforeIndex))
}

export function closeNonPairedParens(template, cut_before) {
	const retained_template = template.slice(0, cut_before)
	const opening_braces = countOccurences('(', retained_template)
	const closing_braces = countOccurences(')', retained_template)
	let dangling_braces = opening_braces - closing_braces
	while (dangling_braces > 0 && cut_before < template.length) {
		if (template[cut_before] === ')') {
			dangling_braces--
		}
		cut_before++
	}
	return template.slice(0, cut_before)
}

// Counts all occurences of a symbol in a string.
// Unicode-unsafe (because using `.split()`).
export function countOccurences(symbol, string) {
	let count = 0
	// Using `.split('')` to iterate through a string here
	// to avoid requiring `Symbol.iterator` polyfill.
	// `.split('')` is generally not safe for Unicode,
	// but in this particular case for counting brackets it is safe.
	// for (const character of string)
	for (const character of string.split('')) {
		if (character === symbol) {
			count++
		}
	}
	return count
}

// Repeats a string (or a symbol) N times.
// http://stackoverflow.com/questions/202605/repeat-string-javascript
export function repeat(string, times) {
	if (times < 1) {
		return ''
	}
	let result = ''
	while (times > 1) {
		if (times & 1) {
			result += string
		}
		times >>= 1
		string += string
	}
	return result + string
}

/**
 * Extracts formatted phone number from text (if there's any).
 * @param  {string} text
 * @return {string} [formattedPhoneNumber]
 */
function extractFormattedPhoneNumber(text) {
	// Attempt to extract a possible number from the string passed in.
	const startsAt = text.search(VALID_PHONE_NUMBER)
	if (startsAt < 0) {
		return
	}
	// Trim everything to the left of the phone number.
	text = text.slice(startsAt)
	// Trim the `+`.
	let hasPlus
	if (text[0] === '+') {
		hasPlus = true
		text = text.slice('+'.length)
	}
	// Trim everything to the right of the phone number.
	text = text.replace(AFTER_PHONE_NUMBER_DIGITS_END_PATTERN, '')
	// Re-add the previously trimmed `+`.
	if (hasPlus) {
		text = '+' + text
	}
	return text
}

function populateTemplateWithDigits(template, position, digits) {
	// Using `.split('')` to iterate through a string here
	// to avoid requiring `Symbol.iterator` polyfill.
	// `.split('')` is generally not safe for Unicode,
	// but in this particular case for `digits` it is safe.
	// for (const digit of digits)
	for (const digit of digits.split('')) {
		// If there is room for more digits in current `template`,
		// then set the next digit in the `template`,
		// and return the formatted digits so far.
		// If more digits are entered than the current format could handle.
		if (template.slice(position + 1).search(DIGIT_PLACEHOLDER_MATCHER) < 0) {
			return
		}
		position = template.search(DIGIT_PLACEHOLDER_MATCHER)
		template = template.replace(DIGIT_PLACEHOLDER_MATCHER, digit)
	}
	return [template, position]
}