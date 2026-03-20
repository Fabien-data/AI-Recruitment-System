# Google Cloud SQL App

This project is a Node.js application that integrates with Google Cloud SQL. It uses TypeScript and Express to provide a RESTful API for interacting with a SQL database.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [API Endpoints](#api-endpoints)
- [License](#license)

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/google-cloud-sql-app.git
   ```
2. Navigate to the project directory:
   ```
   cd google-cloud-sql-app
   ```
3. Install the dependencies:
   ```
   npm install
   ```

## Usage

1. Create a `.env` file in the root directory based on the `.env.example` file and fill in your database credentials.
2. Start the application:
   ```
   npm start
   ```

## Configuration

The database connection settings can be configured in the `src/config/database.ts` file. Ensure that you provide the correct host, user, password, and database name.

## API Endpoints

- `GET /records`: Retrieve all records from the database.
- `POST /records`: Create a new record in the database.

## License

This project is licensed under the MIT License.