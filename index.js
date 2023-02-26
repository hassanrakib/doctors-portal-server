const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
require("dotenv").config();
const port = process.env.PORT || 5000;

const app = express();

// middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster-1.yey930g.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri);

async function run() {
  try {
    // collections
    const appointmentOptions = client
      .db("doctors_Portal")
      .collection("appointment_Options");
    const bookings = client.db("doctors_Portal").collection("bookings");

    // get appointmentOptions
    app.get("/appointment-options", async (req, res) => {
      const date = req.query.date;
      const query = {};
      const cursor = appointmentOptions.find(query);
      const appointmentOptionsArr = await cursor.toArray();

      // get bookings by specific date
      const queryBookingsByDate = { appointmentDate: date };
      const bookingsByDate = await bookings.find(queryBookingsByDate).toArray();

      appointmentOptionsArr.forEach((appointmentOption) => {
        // get bookings of specific appointment option
        const bookingsByAppointmentOption = bookingsByDate.filter(
          (booking) => booking.treatment === appointmentOption.name
        );
        const bookedSlots = bookingsByAppointmentOption.map(
          (booking) => booking.slot
        );

        // remaining slots of the specific appointment option
        const remainingSlots = appointmentOption.slots.filter(
          (slot) => !bookedSlots.includes(slot)
        );

        // re assign the slots property of the specific appointment option
        appointmentOption.slots = remainingSlots;
      });

      res.send(appointmentOptionsArr);
    });

    // create new booking
    app.post("/bookings", async (req, res) => {
      const booking = req.body;
      const result = await bookings.insertOne(booking);
      res.send(result);
    });
  } finally {
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("doctors portal server");
});

app.listen(port, () => {
  console.log(`Server is running in port ${port}`);
});
