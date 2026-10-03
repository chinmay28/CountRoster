import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AboutSection, NOTICES_PATH, SOURCE_URL } from '../components/AboutSection.tsx';

describe('AboutSection', () => {
  it('links the source (AGPL) and the third-party notices', () => {
    render(<AboutSection />);
    expect(screen.getByText(/GNU Affero General Public License v3\.0/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', SOURCE_URL);
    expect(screen.getByRole('link', { name: 'Open-source licences' })).toHaveAttribute('href', NOTICES_PATH);
  });
});
