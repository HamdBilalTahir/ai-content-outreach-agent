import { render } from '@testing-library/react';
import Home from './page';

describe('Home', () => {
  it('renders without crashing', () => {
    const { container } = render(<Home />);
    expect(container).toBeInTheDocument();
  });
});
