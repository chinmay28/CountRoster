import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="empty">
      <h1>Page not found</h1>
      <Link to="/" className="btn btn--primary">
        Back home
      </Link>
    </div>
  );
}
