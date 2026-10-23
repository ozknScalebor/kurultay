#pragma once
#include <cstddef>
#include <stdexcept>
#include <vector>

namespace telemetri {

/// Fixed-capacity circular buffer. When full, push() overwrites the oldest element.
/// at(0) is always the oldest element, at(size()-1) the newest.
template <typename T>
class RingBuffer {
public:
    explicit RingBuffer(std::size_t capacity) : buf_(capacity) {
        if (capacity == 0) throw std::invalid_argument("kapasite 0 olamaz");
    }

    void push(const T& value) {
        buf_[head_] = value;
        head_ = (head_ + 1) % buf_.size();
        if (count_ < buf_.size()) {
            ++count_;
        } else {
            tail_ = (tail_ + 1) % buf_.size();  // the oldest element was overwritten
        }
    }

    /// Removes and returns the oldest element.
    T pop() {
        if (count_ == 0) throw std::out_of_range("tampon boş");
        T v = buf_[tail_];
        tail_ = (tail_ + 1) % buf_.size();
        --count_;
        return v;
    }

    const T& at(std::size_t i) const {
        if (i >= count_) throw std::out_of_range("indeks aralık dışında");
        return buf_[(tail_ + i) % buf_.size()];
    }

    std::vector<T> to_vector() const {
        std::vector<T> out;
        out.reserve(count_);
        for (std::size_t i = 0; i < count_; ++i) out.push_back(at(i));
        return out;
    }

    std::size_t size() const { return count_; }
    std::size_t capacity() const { return buf_.size(); }
    bool empty() const { return count_ == 0; }
    bool full() const { return count_ == buf_.size(); }

private:
    std::vector<T> buf_;
    std::size_t head_ = 0;  // bir sonraki yazma konumu
    std::size_t tail_ = 0;  // en eski eleman
    std::size_t count_ = 0;
};

}  // namespace telemetri
