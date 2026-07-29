import { useMemo } from 'react';
import PhoneInputLib, { type Country } from 'react-phone-number-input';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import 'react-phone-number-input/style.css';

interface PhoneInputProps {
  value?: string;
  onChange?: (value: string | undefined) => void;
  defaultCountry?: Country;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

// Convert phone number to E.164 format if it's not already
const normalizePhoneNumber = (
  phoneNumber: string | undefined,
  defaultCountry: Country
): string | undefined => {
  if (!phoneNumber) return undefined;

  // If already in E.164 format (starts with +), return as is
  if (phoneNumber.startsWith('+')) {
    return phoneNumber;
  }

  // Remove any non-digit characters
  const cleaned = phoneNumber.replace(/\D/g, '');

  if (cleaned.length === 0) return undefined;

  // For India (IN), country code is 91
  // If we have a 10-digit number and default country is IN, prepend +91
  if (defaultCountry === 'IN' && cleaned.length === 10) {
    return `+91${cleaned}`;
  }

  // If the cleaned number already starts with country code (e.g., 919876543210 for India)
  // and default country is IN, ensure it has the + prefix
  if (defaultCountry === 'IN' && cleaned.length === 12 && cleaned.startsWith('91')) {
    return `+${cleaned}`;
  }

  // For other cases, return the original value
  // The library will attempt to parse it, but may show a warning
  // This is a fallback - ideally the API should return E.164 format
  return phoneNumber;
};

export const PhoneInput = ({
  value,
  onChange,
  defaultCountry = 'IN',
  className,
  placeholder = 'Enter phone number',
  disabled,
}: PhoneInputProps) => {
  // Normalize the value to E.164 format
  const normalizedValue = useMemo(() => {
    return normalizePhoneNumber(value, defaultCountry);
  }, [value, defaultCountry]);

  return (
    <PhoneInputLib
      international
      countryCallingCodeEditable={false}
      limitMaxLength={true}
      defaultCountry={defaultCountry}
      value={normalizedValue}
      //@ts-expect-error onChange type mismatch
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        'flex px-3 py-2 rounded-md border border-input bg-background',
        disabled && 'opacity-60',
        className
      )}
      inputComponent={Input}
    />
  );
};
