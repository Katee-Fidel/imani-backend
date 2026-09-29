const mongoose = require('mongoose');

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI is not defined');
  const conn = await mongoose.connect(uri);
  console.log(`MongoDB Imani-verse connected: ${conn.connection.host}/${conn.connection.name}`);
};

module.exports = connectDB;