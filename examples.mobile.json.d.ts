import { CountryCode, NationalNumber } from './types';

export default interface Examples {
  // `in` operator docs:
  // https://www.typescriptlang.org/docs/handbook/advanced-types.html#mapped-types
  // `country in CountryCode` means "for each and every CountryCode".
  [country in CountryCode]: NationalNumber;
};
